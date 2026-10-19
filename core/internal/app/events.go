package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	eventClientLimit  = 64
	eventControlQueue = 32
	eventPayloadLimit = 128 * 1024 * 1024
	eventWriteTimeout = 15 * time.Second
	eventHeartbeat    = 20 * time.Second
	stateCoalescing   = 60 * time.Millisecond
)

type eventClient struct {
	ctx     context.Context
	cancel  context.CancelFunc
	states  chan []byte
	control chan []byte
}

type eventHub struct {
	mu      sync.Mutex
	clients map[*eventClient]struct{}
	closed  bool
}

func newEventHub() *eventHub {
	return &eventHub{clients: make(map[*eventClient]struct{})}
}

func (hub *eventHub) subscribe(ctx context.Context) (*eventClient, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed || len(hub.clients) >= eventClientLimit {
		return nil, false
	}
	owner, cancel := context.WithCancel(ctx)
	client := &eventClient{
		ctx: owner, cancel: cancel,
		states: make(chan []byte, 1), control: make(chan []byte, eventControlQueue),
	}
	hub.clients[client] = struct{}{}
	return client, true
}

func (hub *eventHub) remove(client *eventClient) {
	hub.mu.Lock()
	delete(hub.clients, client)
	hub.mu.Unlock()
	client.cancel()
}

func eventBytes(kind string, data any) []byte {
	raw, err := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{kind, data})
	if err != nil || len(raw) > eventPayloadLimit {
		return nil
	}
	return raw
}

// A state supersedes older observations. Control events retain order and close
// a slow subscriber on overflow; no client can grow an unbounded queue.
func (hub *eventHub) publish(kind string, data any) {
	raw := eventBytes(kind, data)
	if raw == nil {
		return
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return
	}
	for client := range hub.clients {
		if kind == "state" {
			select {
			case <-client.states:
			default:
			}
			client.states <- raw
			continue
		}
		select {
		case client.control <- raw:
		default:
			delete(hub.clients, client)
			client.cancel()
		}
	}
}

func (hub *eventHub) close() {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	hub.closed = true
	for client := range hub.clients {
		client.cancel()
		delete(hub.clients, client)
	}
}

func (app *WorkerApp) broadcast() {
	defer app.wg.Done()
	changes, unsubscribe := app.engine.Subscribe()
	defer unsubscribe()
	signals, unsubscribeSignals, err := app.engine.SubscribeSignals()
	if err != nil {
		return
	}
	defer unsubscribeSignals()
	persistence, unsubscribeStore := app.store.Subscribe()
	defer unsubscribeStore()

	timer := time.NewTimer(stateCoalescing)
	defer timer.Stop()
	var pending <-chan time.Time = timer.C
	mark := func() {
		if pending == nil {
			timer.Reset(stateCoalescing)
			pending = timer.C
		}
	}
	for {
		select {
		case <-app.ctx.Done():
			return
		case _, open := <-changes:
			if !open {
				return
			}
			mark()
		case _, open := <-persistence:
			if !open {
				return
			}
			mark()
		case <-app.wake:
			mark()
		case signal, open := <-signals:
			if !open {
				return
			}
			app.events.publish(signal.Type, signal.Data)
		case <-pending:
			pending = nil
			snapshot, err := app.Snapshot(app.ctx)
			if err == nil {
				app.events.publish("state", snapshot)
			}
			if app.telegram != nil {
				app.telegram.Wake()
			}
		}
	}
}

func (app *WorkerApp) serveSSE(writer http.ResponseWriter, request *http.Request) {
	if _, ok := writer.(http.Flusher); !ok {
		http.Error(writer, "Event stream unavailable", http.StatusInternalServerError)
		return
	}
	client, ok := app.events.subscribe(request.Context())
	if !ok {
		http.Error(writer, "Too many event streams", http.StatusServiceUnavailable)
		return
	}
	defer app.events.remove(client)
	snapshot, err := app.Snapshot(request.Context())
	if err != nil {
		http.Error(writer, "State unavailable", http.StatusServiceUnavailable)
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(writer)
	write := func(raw []byte) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(eventWriteTimeout))
		if _, err := writer.Write(raw); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	frame := func(raw []byte) bool {
		if len(raw) == 0 {
			return false
		}
		return write(append(append([]byte("data: "), raw...), '\n', '\n'))
	}
	if !frame(eventBytes("state", snapshot)) {
		return
	}
	heartbeat := time.NewTicker(eventHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-client.ctx.Done():
			return
		case <-app.ctx.Done():
			return
		case raw := <-client.control:
			if !frame(raw) {
				return
			}
		case raw := <-client.states:
			if !frame(raw) {
				return
			}
		case <-heartbeat.C:
			if !write([]byte(": heartbeat\n\n")) {
				return
			}
		}
	}
}

func (app *WorkerApp) serveWebSocket(writer http.ResponseWriter, request *http.Request) {
	if !app.auth.CheckUpgrade(request) {
		http.Error(writer, "Forbidden", http.StatusForbidden)
		return
	}
	client, ok := app.events.subscribe(request.Context())
	if !ok {
		http.Error(writer, "Too many event streams", http.StatusServiceUnavailable)
		return
	}
	defer app.events.remove(client)
	snapshot, err := app.Snapshot(request.Context())
	if err != nil {
		http.Error(writer, "State unavailable", http.StatusServiceUnavailable)
		return
	}
	// SessionAuth already validates the exact local or tauri origin, including
	// schemes the library's ordinary HTTP-origin parser cannot represent.
	socket, err := websocket.Accept(writer, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	socket.SetReadLimit(1024 * 1024)
	ctx, cancel := context.WithCancel(client.ctx)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		for {
			_, input, err := socket.Reader(ctx)
			if err != nil {
				return
			}
			if _, err = io.Copy(io.Discard, input); err != nil {
				return
			}
		}
	}()
	defer func() {
		cancel()
		socket.CloseNow()
		<-readerDone
	}()
	write := func(raw []byte) bool {
		if len(raw) == 0 {
			return false
		}
		bounded, stop := context.WithTimeout(ctx, eventWriteTimeout)
		defer stop()
		return socket.Write(bounded, websocket.MessageText, raw) == nil
	}
	if !write(eventBytes("state", snapshot)) {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-app.ctx.Done():
			return
		case raw := <-client.control:
			if !write(raw) {
				return
			}
		case raw := <-client.states:
			if !write(raw) {
				return
			}
		}
	}
}
