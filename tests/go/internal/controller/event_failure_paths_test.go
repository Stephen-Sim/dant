package controller

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
)

type controllerBoundedEventWriter struct {
	header http.Header
	frames chan struct{}
	writes atomic.Int32
}

func (writer *controllerBoundedEventWriter) Header() http.Header       { return writer.header }
func (*controllerBoundedEventWriter) WriteHeader(int)                  {}
func (*controllerBoundedEventWriter) Flush()                           {}
func (*controllerBoundedEventWriter) SetWriteDeadline(time.Time) error { return nil }
func (writer *controllerBoundedEventWriter) Write(data []byte) (int, error) {
	if writer.writes.Add(1) > 1 {
		return 0, errors.New("synthetic event destination failed")
	}
	writer.frames <- struct{}{}
	return len(data), nil
}

func TestControllerSSEOwnsFailedEventWritesHeartbeatAndServiceCancellation(t *testing.T) {
	for _, mode := range []string{"queued-write", "heartbeat-write", "service-cancelled"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				app, err := New(t.Context(), controllerIsolatedOptions(t))
				if err != nil {
					t.Fatal(err)
				}
				defer app.Close()
				writer := &controllerBoundedEventWriter{header: make(http.Header), frames: make(chan struct{}, 1)}
				request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/api/events", nil)
				request.Header.Set("X-Dant-Token", app.auth.Info().Token)
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					app.Handler().ServeHTTP(writer, request)
				}()
				<-writer.frames
				switch mode {
				case "queued-write":
					app.events.publish("notice", "synthetic bounded event")
				case "heartbeat-write":
					time.Sleep(21 * time.Second)
				case "service-cancelled":
					app.cancel()
				}
				<-finished
				app.events.mu.Lock()
				remaining := len(app.events.clients)
				app.events.mu.Unlock()
				if remaining != 0 {
					t.Fatal("closed SSE retained its event subscriber")
				}
			})
		})
	}
}

func TestControllerWebSocketJoinsAnInterruptedMessageReader(t *testing.T) {
	app, _, server, token := controllerAppFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/events?token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow()
	if _, _, err := socket.Read(ctx); err != nil {
		t.Fatal("initial isolated state missing", err)
	}
	writer, err := socket.Writer(ctx, websocket.MessageText)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.Write([]byte(strings.Repeat("x", 64*1024))); err != nil {
		t.Fatal(err)
	}
	// Close before the final message fragment. The service's reader must
	// reject this interrupted transport and release the whole subscription.
	_ = socket.CloseNow()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		app.events.mu.Lock()
		remaining := len(app.events.clients)
		app.events.mu.Unlock()
		if remaining == 0 {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("interrupted message retained the socket reader owner")
		case <-time.After(time.Millisecond):
		}
	}
}
