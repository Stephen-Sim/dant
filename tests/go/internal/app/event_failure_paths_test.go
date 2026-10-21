package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
)

type boundedEventWriter struct {
	header http.Header
	frames chan struct{}
	writes atomic.Int32
}

func (writer *boundedEventWriter) Header() http.Header       { return writer.header }
func (*boundedEventWriter) WriteHeader(int)                  {}
func (*boundedEventWriter) Flush()                           {}
func (*boundedEventWriter) SetWriteDeadline(time.Time) error { return nil }
func (writer *boundedEventWriter) Write(value []byte) (int, error) {
	if writer.writes.Add(1) > 1 {
		return 0, errors.New("synthetic failed event destination")
	}
	writer.frames <- struct{}{}
	return len(value), nil
}

func TestWorkerSSEClosesEmptyFramesFailedWritesAndWorkerLifetimeWithoutLeakingSubscribers(t *testing.T) {
	for _, mode := range []string{"empty-control", "empty-state", "control-write", "state-write", "heartbeat-write", "lifetime"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				app := fixtureWorker(t)
				original := app.ctx
				lifetime, cancel := context.WithCancel(t.Context())
				app.ctx = lifetime
				defer func() { cancel(); app.ctx = original }()
				writer := &boundedEventWriter{header: make(http.Header), frames: make(chan struct{}, 1)}
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					app.serveSSE(writer, httptest.NewRequest(http.MethodGet, "/api/events", nil))
				}()
				<-writer.frames
				app.events.mu.Lock()
				var client *eventClient
				for current := range app.events.clients {
					client = current
				}
				app.events.mu.Unlock()
				if client == nil {
					t.Fatal("initial stream did not retain its owner")
				}
				switch mode {
				case "empty-control":
					client.control <- nil
				case "empty-state":
					client.states <- nil
				case "control-write":
					app.events.publish("notice", "fixture")
				case "state-write":
					app.events.publish("state", "fixture")
				case "heartbeat-write":
					time.Sleep(eventHeartbeat + time.Second)
				case "lifetime":
					cancel()
				}
				<-finished
				if len(app.events.clients) != 0 || client.ctx.Err() == nil {
					t.Fatal("failed or retired stream retained its owner")
				}
			})
		})
	}
}

func TestWorkerWebSocketRejectsEmptyQueuedFramesAndJoinsItsReader(t *testing.T) {
	for _, mode := range []string{"control", "state"} {
		t.Run(mode, func(t *testing.T) {
			app := fixtureWorker(t)
			server := httptest.NewServer(app.Handler())
			t.Cleanup(server.Close)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			endpoint := "ws" + server.URL[len("http"):] + "/events?token=" + app.auth.Info().Token
			socket, _, err := websocket.Dial(ctx, endpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer socket.CloseNow()
			if _, _, err := socket.Read(ctx); err != nil {
				t.Fatal("initial socket state missing", err)
			}
			app.events.mu.Lock()
			for client := range app.events.clients {
				if mode == "control" {
					client.control <- nil
				} else {
					client.states <- nil
				}
			}
			app.events.mu.Unlock()
			if _, _, err := socket.Read(ctx); err == nil {
				t.Fatal("empty event frame was sent as a valid socket message")
			}
		})
	}
}
