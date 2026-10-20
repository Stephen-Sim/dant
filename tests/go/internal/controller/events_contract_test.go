package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestControllerEventSubscribersAreBoundedAndSlowClientsAreRetired(t *testing.T) {
	hub := newEventHub()
	clients := make([]*eventClient, 0, eventClientLimit)
	for range eventClientLimit {
		client, ok := hub.subscribe(context.Background())
		if !ok {
			t.Fatal("event capacity rejected an admitted client")
		}
		clients = append(clients, client)
	}
	if _, ok := hub.subscribe(context.Background()); ok {
		t.Fatal("event subscriber cap was exceeded")
	}
	for range eventQueueLimit {
		hub.publish("state", struct{ Ready bool }{true})
	}
	hub.publish("state", struct{ Ready bool }{false})
	for _, client := range clients {
		select {
		case <-client.ctx.Done():
		default:
			t.Fatal("slow event client retained an unbounded queue")
		}
	}
	if len(hub.clients) != 0 {
		t.Fatal("retired event clients still consumed capacity")
	}
	client, ok := hub.subscribe(context.Background())
	if !ok {
		t.Fatal("retiring slow clients did not free event capacity")
	}
	hub.publish("invalid", make(chan bool))
	hub.publish("oversized", strings.Repeat("x", eventPayloadLimit))
	if len(client.queue) != 0 {
		t.Fatal("unserializable or oversized payload entered the event queue")
	}
	hub.close()
	hub.publish("after-close", struct{}{})
	if _, ok := hub.subscribe(context.Background()); ok || client.ctx.Err() == nil || len(client.queue) != 0 {
		t.Fatal("closed event owner admitted clients or continued publishing")
	}
}

type controllerPlainWriter struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (writer *controllerPlainWriter) Header() http.Header           { return writer.header }
func (writer *controllerPlainWriter) WriteHeader(code int)          { writer.code = code }
func (writer *controllerPlainWriter) Write(raw []byte) (int, error) { return writer.body.Write(raw) }

type controllerStreamWriter struct {
	*httptest.ResponseRecorder
	writes     int
	onWrite    func(int)
	writeError bool
	flushError bool
}

func (writer *controllerStreamWriter) Write(raw []byte) (int, error) {
	writer.writes++
	if writer.writeError {
		return 0, io.ErrClosedPipe
	}
	written, err := writer.ResponseRecorder.Write(raw)
	if writer.onWrite != nil {
		writer.onWrite(writer.writes)
	}
	return written, err
}

func (writer *controllerStreamWriter) FlushError() error {
	if writer.flushError {
		return io.ErrClosedPipe
	}
	writer.ResponseRecorder.Flush()
	return nil
}

func TestControllerSSEProvidesInitialStateAndPublishedEventsThenReleasesOwner(t *testing.T) {
	app, _, _, _ := controllerAppFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := &controllerStreamWriter{ResponseRecorder: httptest.NewRecorder()}
	writer.onWrite = func(count int) {
		if count == 1 {
			app.events.publish("backups", struct {
				Changed bool `json:"changed"`
			}{true})
		} else {
			cancel()
		}
	}
	app.serveSSE(writer, httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx))
	if writer.writes != 2 || writer.Header().Get("Content-Type") != "text/event-stream" || writer.Header().Get("X-Accel-Buffering") != "no" || !strings.Contains(writer.Body.String(), `"type":"state"`) || !strings.Contains(writer.Body.String(), `"type":"backups"`) || len(app.events.clients) != 0 {
		t.Fatal("SSE omitted its initial/event stream or leaked a subscription after cancellation")
	}
}

func TestControllerSSERejectsUnsupportedWritersAndReleasesFailedStreams(t *testing.T) {
	app, _, _, _ := controllerAppFixture(t)
	plain := &controllerPlainWriter{header: http.Header{}}
	app.serveSSE(plain, httptest.NewRequest("GET", "/api/events", nil))
	if plain.code != 500 || len(app.events.clients) != 0 {
		t.Fatal("SSE accepted an unflushable response")
	}
	for _, failWrite := range []bool{true, false} {
		writer := &controllerStreamWriter{ResponseRecorder: httptest.NewRecorder(), writeError: failWrite, flushError: !failWrite}
		app.serveSSE(writer, httptest.NewRequest("GET", "/api/events", nil))
		if writer.writes != 1 || len(app.events.clients) != 0 {
			t.Fatal("failed event write/flush retained an event owner")
		}
	}
	app.events.close()
	response := httptest.NewRecorder()
	app.serveSSE(response, httptest.NewRequest("GET", "/api/events", nil))
	if response.Code != 503 {
		t.Fatal("closed SSE owner was admitted")
	}
}

func TestControllerEventSocketValidatesUpgradeAndSharesBoundedEventCapacity(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	request := httptest.NewRequest("GET", "http://127.0.0.1:4317/events?token="+token, nil)
	response := httptest.NewRecorder()
	app.serveWebSocket(response, request)
	if response.Code != 426 || len(app.events.clients) != 0 {
		t.Fatal("non-upgrade request retained a socket subscription")
	}
	for range eventClientLimit {
		if _, ok := app.events.subscribe(context.Background()); !ok {
			t.Fatal("fixture event capacity unexpectedly exhausted")
		}
	}
	response = httptest.NewRecorder()
	app.serveWebSocket(response, request)
	if response.Code != 503 {
		t.Fatal("WebSocket bypassed shared event subscriber cap")
	}
	app.events.close()
}

func TestControllerEventSocketConsumesClientFramesAndRelaysCurrentEvents(t *testing.T) {
	app, _, server, token := controllerAppFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/events?token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow()
	if _, _, err := socket.Read(ctx); err != nil {
		t.Fatal("initial current-state event unavailable")
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(`{"fixture":"client frame is ignored"}`)); err != nil {
		t.Fatal(err)
	}
	app.events.publish("backups", struct {
		Changed bool `json:"changed"`
	}{true})
	_, raw, err := socket.Read(ctx)
	var event struct {
		Type string
		Data struct{ Changed bool }
	}
	if err != nil || json.Unmarshal(raw, &event) != nil || event.Type != "backups" || !event.Data.Changed {
		t.Fatal("current server event did not reach the socket owner")
	}
	if err := socket.Close(websocket.StatusNormalClosure, ""); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal("fixture socket could not close")
	}
}
