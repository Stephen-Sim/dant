package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
)

func TestWorkerWebSocketMaintainsInitialStateOrderedControlsAndJoinedDisconnect(t *testing.T) {
	app := fixtureWorker(t)
	server := httptest.NewServer(app.Handler())
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http") + "/events?token=" + app.auth.Info().Token
	socket, response, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal("isolated WebSocket handshake failed", err)
	}
	defer socket.CloseNow()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal("socket was not upgraded")
	}
	read := func(kind string) json.RawMessage {
		t.Helper()
		messageType, raw, err := socket.Read(ctx)
		if err != nil || messageType != websocket.MessageText {
			t.Fatal("socket frame did not arrive", err)
		}
		var envelope struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Type != kind {
			t.Fatal("event identity or encoding changed")
		}
		return envelope.Data
	}
	initial := read("state")
	if !strings.Contains(string(initial), app.store.ConversationID()) {
		t.Fatal("initial socket state lost conversation")
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(`{"ignored":"client event"}`)); err != nil {
		t.Fatal(err)
	}
	for _, number := range []int{1, 2} {
		app.events.publish("notice", number)
		if string(read("notice")) != string(rune('0'+number)) {
			t.Fatal("control events were reordered")
		}
	}
	app.events.publish("state", "current state")
	if string(read("state")) != `"current state"` {
		t.Fatal("state update was lost")
	}
	app.events.close()
	if _, _, err := socket.Read(ctx); err == nil {
		t.Fatal("closed hub left subscriber alive")
	}
}

type appStreamWriter struct {
	header http.Header
	frames chan string
}

func (writer *appStreamWriter) Header() http.Header       { return writer.header }
func (*appStreamWriter) WriteHeader(int)                  {}
func (*appStreamWriter) Flush()                           {}
func (*appStreamWriter) SetWriteDeadline(time.Time) error { return nil }
func (writer *appStreamWriter) Write(raw []byte) (int, error) {
	writer.frames <- string(raw)
	return len(raw), nil
}

func TestWorkerSSEHeartbeatControlsStateAndCancellationUseVirtualTime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		app := fixtureWorker(t)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		writer := &appStreamWriter{header: make(http.Header), frames: make(chan string, 16)}
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			app.serveSSE(writer, request)
		}()
		if initial := <-writer.frames; !strings.HasPrefix(initial, "data: ") || !strings.Contains(initial, app.store.ConversationID()) {
			t.Fatal("SSE initial state lost its identity")
		}
		app.events.publish("notice", "ordered fixture notice")
		if control := <-writer.frames; !strings.Contains(control, "ordered fixture notice") {
			t.Fatal("SSE control event was lost")
		}
		app.events.publish("state", "latest fixture state")
		if state := <-writer.frames; !strings.Contains(state, "latest fixture state") {
			t.Fatal("SSE state update was lost")
		}
		time.Sleep(eventHeartbeat + time.Second)
		if heartbeat := <-writer.frames; heartbeat != ": heartbeat\n\n" {
			t.Fatal("SSE heartbeat framing changed")
		}
		cancel()
		<-finished
		if len(app.events.clients) != 0 {
			t.Fatal("cancelled SSE retained a subscriber")
		}
	})
}

func TestWorkerEventSnapshotFailureDoesNotUpgradeOrAdvertiseStreamSuccess(t *testing.T) {
	app := fixtureWorker(t)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/events?token="+app.auth.Info().Token, nil)
	response := httptest.NewRecorder()
	app.serveWebSocket(response, request)
	if response.Code < 400 || len(app.events.clients) != 0 {
		t.Fatal("non-upgrade request retained a socket subscriber")
	}
	if err := app.memory.Close(); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	app.serveWebSocket(response, request)
	requireWorkerStatus(t, response, 503)
	response = httptest.NewRecorder()
	app.serveSSE(response, request)
	requireWorkerStatus(t, response, 503)
	if len(app.events.clients) != 0 || response.Header().Get("Content-Type") == "text/event-stream" {
		t.Fatal("failed state retained stream ownership or success headers")
	}
}

type noFlushWriter struct {
	header http.Header
	status int
}

func (writer *noFlushWriter) Header() http.Header            { return writer.header }
func (writer *noFlushWriter) WriteHeader(status int)         { writer.status = status }
func (writer *noFlushWriter) Write(data []byte) (int, error) { return len(data), nil }

type failedEventWriter struct {
	noFlushWriter
	writes int
}

func (*failedEventWriter) Flush()                           {}
func (*failedEventWriter) SetWriteDeadline(time.Time) error { return nil }
func (writer *failedEventWriter) Write([]byte) (int, error) {
	writer.writes++
	return 0, errors.New("isolated_event_sink_failure")
}

func TestWorkerEventEndpointsRejectUnavailableOwnersAndReleaseFailedSinks(t *testing.T) {
	app := fixtureWorker(t)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/api/events", nil)
	plain := &noFlushWriter{header: make(http.Header)}
	app.serveSSE(plain, request)
	if plain.status != 500 {
		t.Fatal("nonstreaming writer was accepted")
	}
	failed := &failedEventWriter{noFlushWriter: noFlushWriter{header: make(http.Header)}}
	app.serveSSE(failed, request)
	if failed.writes != 1 || len(app.events.clients) != 0 {
		t.Fatal("failed event sink was replayed or retained")
	}
	response := httptest.NewRecorder()
	app.serveWebSocket(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/events?token=invalid", nil))
	requireWorkerStatus(t, response, 403)
	for range eventClientLimit {
		if _, accepted := app.events.subscribe(t.Context()); !accepted {
			t.Fatal("client limit was reached early")
		}
	}
	response = httptest.NewRecorder()
	app.serveSSE(response, request)
	requireWorkerStatus(t, response, 503)
	response = httptest.NewRecorder()
	app.serveWebSocket(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/events?token="+app.auth.Info().Token, nil))
	requireWorkerStatus(t, response, 503)
	app.events.close()
	if _, accepted := app.events.subscribe(t.Context()); accepted {
		t.Fatal("closed event hub accepted a subscriber")
	}
	app.events.publish("notice", "ignored after close")
	if len(app.events.clients) != 0 {
		t.Fatal("closed hub retained clients")
	}
}

func TestWorkerEventSerializationAndConcurrentDisconnectNeverPublishInvalidFrames(t *testing.T) {
	hub := newEventHub()
	defer hub.close()
	client, accepted := hub.subscribe(t.Context())
	if !accepted {
		t.Fatal("subscription unavailable")
	}
	hub.publish("notice", make(chan int))
	if len(client.control) != 0 || eventBytes("notice", func() {}) != nil {
		t.Fatal("unsupported JSON became a wire frame")
	}
	var joined sync.WaitGroup
	joined.Add(2)
	go func() {
		defer joined.Done()
		for index := range 100 {
			hub.publish("state", index)
		}
	}()
	go func() {
		defer joined.Done()
		hub.remove(client)
	}()
	joined.Wait()
	if len(hub.clients) != 0 || client.ctx.Err() == nil {
		t.Fatal("concurrent removal retained its owner")
	}
}
