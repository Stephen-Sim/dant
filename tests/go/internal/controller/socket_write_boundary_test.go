package controller

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type controllerFaultSocket struct {
	net.Conn
	fail *atomic.Bool
}

func (connection *controllerFaultSocket) Write(raw []byte) (int, error) {
	if connection.fail.Load() {
		return 0, io.ErrClosedPipe
	}
	return connection.Conn.Write(raw)
}

type controllerFaultUpgrade struct {
	http.ResponseWriter
	fail *atomic.Bool
}

func (writer controllerFaultUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := writer.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if err := buffer.Writer.Flush(); err != nil {
		_ = connection.Close()
		return nil, nil, err
	}
	wrapped := &controllerFaultSocket{Conn: connection, fail: writer.fail}
	buffer.Writer.Reset(wrapped)
	return wrapped, buffer, nil
}

func TestControllerSocketWriteFailureJoinsItsReaderAndReleasesCapacity(t *testing.T) {
	for _, initial := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued event", true: "initial state"}[initial], func(t *testing.T) {
			app, _, _, token := controllerAppFixture(t)
			var fail atomic.Bool
			fail.Store(initial)
			finished := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				defer close(finished)
				app.serveWebSocket(controllerFaultUpgrade{ResponseWriter: writer, fail: &fail}, request)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/events?token="+token, nil)
			if err != nil {
				t.Fatal("HTTP upgrade failed before the intended frame boundary", err)
			}
			defer socket.CloseNow()
			if !initial {
				if _, _, err := socket.Read(ctx); err != nil {
					t.Fatal("initial socket state was not delivered", err)
				}
				fail.Store(true)
				app.events.publish("notice", struct{ Message string }{"bounded isolated event"})
			}
			if _, _, err := socket.Read(ctx); err == nil {
				t.Fatal("failed socket frame was published as complete")
			}
			select {
			case <-finished:
			case <-ctx.Done():
				t.Fatal("socket write failure did not join its reader")
			}
			app.events.mu.Lock()
			remaining := len(app.events.clients)
			app.events.mu.Unlock()
			if remaining != 0 {
				t.Fatal("failed socket retained event capacity")
			}
		})
	}
}
