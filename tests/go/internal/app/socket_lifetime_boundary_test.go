package app

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

type appFaultSocket struct {
	net.Conn
	fail *atomic.Bool
}

func (connection *appFaultSocket) Write(raw []byte) (int, error) {
	if connection.fail.Load() {
		return 0, io.ErrClosedPipe
	}
	return connection.Conn.Write(raw)
}

type appFaultUpgrade struct {
	http.ResponseWriter
	fail *atomic.Bool
}

func (writer appFaultUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := writer.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if err := buffer.Writer.Flush(); err != nil {
		_ = connection.Close()
		return nil, nil, err
	}
	wrapped := &appFaultSocket{Conn: connection, fail: writer.fail}
	buffer.Writer.Reset(wrapped)
	return wrapped, buffer, nil
}

func TestWorkerSocketFailureAndLifetimeJoinEveryAdmittedReader(t *testing.T) {
	for _, mode := range []string{"initial-write", "lifetime", "interrupted-message"} {
		t.Run(mode, func(t *testing.T) {
			app := fixtureWorker(t)
			var fail atomic.Bool
			fail.Store(mode == "initial-write")
			finished := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				defer close(finished)
				app.serveWebSocket(appFaultUpgrade{ResponseWriter: writer, fail: &fail}, request)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/events?token="+app.auth.Info().Token, nil)
			if err != nil {
				t.Fatal("HTTP upgrade failed before the intended lifetime boundary", err)
			}
			defer socket.CloseNow()
			if mode != "initial-write" {
				if _, _, err := socket.Read(ctx); err != nil {
					t.Fatal("initial socket state was not delivered", err)
				}
			}
			if mode == "lifetime" {
				app.cancel()
			} else if mode == "interrupted-message" {
				writer, err := socket.Writer(ctx, websocket.MessageText)
				if err != nil {
					t.Fatal(err)
				}
				defer writer.Close()
				if _, err := writer.Write([]byte(strings.Repeat("x", 64*1024))); err != nil {
					t.Fatal(err)
				}
				_ = socket.CloseNow()
			}
			if _, _, err := socket.Read(ctx); err == nil {
				t.Fatal("failed socket frame or retired lifetime was published as complete")
			}
			select {
			case <-finished:
			case <-ctx.Done():
				t.Fatal("socket failure did not join its reader")
			}
			app.events.mu.Lock()
			remaining := len(app.events.clients)
			app.events.mu.Unlock()
			if remaining != 0 {
				t.Fatal("retired socket retained bounded event capacity")
			}
		})
	}
}
