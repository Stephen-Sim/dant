package controller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const eventClientLimit = 64
const eventQueueLimit = 8
const eventPayloadLimit = 8 * 1024 * 1024
const eventWriteTimeout = 15 * time.Second

type eventClient struct {
	queue  chan []byte
	ctx    context.Context
	cancel context.CancelFunc
}

type eventHub struct {
	mu      sync.Mutex
	clients map[*eventClient]struct{}
	closed  bool
}

func newEventHub() *eventHub { return &eventHub{clients: map[*eventClient]struct{}{}} }
func (hub *eventHub) subscribe(ctx context.Context) (*eventClient, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed || len(hub.clients) >= eventClientLimit {
		return nil, false
	}
	owner, cancel := context.WithCancel(ctx)
	client := &eventClient{queue: make(chan []byte, eventQueueLimit), ctx: owner, cancel: cancel}
	hub.clients[client] = struct{}{}
	return client, true
}

func (hub *eventHub) remove(client *eventClient) {
	hub.mu.Lock()
	delete(hub.clients, client)
	hub.mu.Unlock()
	client.cancel()
}

func (hub *eventHub) publish(kind string, data any) {
	raw, err := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{kind, data})
	if err != nil || len(raw) > eventPayloadLimit {
		return
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return
	}
	for client := range hub.clients {
		select {
		case client.queue <- raw:
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

func (app *App) serveSSE(writer http.ResponseWriter, request *http.Request) {
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
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.Header().Set("Connection", "keep-alive")
	controller := http.NewResponseController(writer)
	write := func(raw []byte) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(eventWriteTimeout))
		if _, err := writer.Write(raw); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	initial, _ := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{"state", app.Snapshot()})
	if !write(append(append([]byte("data: "), initial...), []byte("\n\n")...)) {
		return
	}
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-client.ctx.Done():
			return
		case <-app.ctx.Done():
			return
		case raw := <-client.queue:
			if !write(append(append([]byte("data: "), raw...), []byte("\n\n")...)) {
				return
			}
		case <-heartbeat.C:
			if !write([]byte(": heartbeat\n\n")) {
				return
			}
		}
	}
}

func (app *App) serveWebSocket(writer http.ResponseWriter, request *http.Request) {
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
	// The exact local/tauri origin and query-token contract was already checked
	// above. The library's HTTP-only origin parser cannot represent tauri://.
	socket, err := websocket.Accept(writer, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer socket.CloseNow()
	socket.SetReadLimit(1024 * 1024)
	ctx, cancel := context.WithCancel(client.ctx)
	defer cancel()
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			_, reader, err := socket.Reader(ctx)
			if err != nil {
				cancel()
				return
			}
			if _, err := io.Copy(io.Discard, reader); err != nil {
				cancel()
				return
			}
		}
	}()
	defer func() {
		cancel()
		socket.CloseNow()
		<-readerDone
	}()
	initial, _ := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{"state", app.Snapshot()})
	write := func(raw []byte) bool {
		bounded, stop := context.WithTimeout(ctx, eventWriteTimeout)
		defer stop()
		return socket.Write(bounded, websocket.MessageText, raw) == nil
	}

	if !write(initial) {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-app.ctx.Done():
			return
		case raw := <-client.queue:
			if !write(raw) {
				return
			}
		}
	}
}
