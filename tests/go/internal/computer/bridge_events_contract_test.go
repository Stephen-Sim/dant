package computer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/coder/websocket"
)

func TestBridgeObserverValidatesFramesBeforeUpdatingTheLiveGeneration(t *testing.T) {
	_, directory := ownedLifecycleFixture(t, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	observed := make(chan BridgeEvent, 16)
	changed := make(chan struct{}, 16)
	tunnel := &tunnelFixture{done: make(chan struct{})}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/session":
			_, _ = writer.Write([]byte(`{"token":"isolated-event-token"}`))
		case "/api/state":
			_ = json.NewEncoder(writer).Encode(bridgeStateFixture())
		case "/events":
			if request.URL.Query().Get("token") != "isolated-event-token" {
				t.Error("observer lost its exact session credential")
			}
			connection, err := websocket.Accept(writer, request, nil)
			if err != nil {
				return
			}
			defer connection.CloseNow()
			_ = connection.Write(ctx, websocket.MessageBinary, []byte(`{"type":"unsafe"}`))
			for _, raw := range []string{
				`{`, `[]`, `{"type":42}`, `{"type":""}`, `{"type":"` + strings.Repeat("x", 129) + `"}`,
				`{"type":"state","data":[]}`, `{"type":"state","data":{"worker":{"status":"future"}}}`,
			} {
				if err := connection.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
					return
				}
			}
			state := bridgeStateFixture()
			state.Settings.Language = "en"
			raw, _ := json.Marshal(struct {
				Type string                   `json:"type"`
				Data contracts.WorkerSnapshot `json:"data"`
			}{"state", state})
			if err := connection.Write(ctx, websocket.MessageText, raw); err != nil {
				return
			}
			if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"realtime","data":{"sequence":7}}`)); err != nil {
				return
			}
			_, _, _ = connection.Read(request.Context())
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	tunnel.endpoint = server.URL
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory, HTTP: server.Client(),
		OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
		Event:      func(event BridgeEvent) { observed <- event },
		Changed: func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bridge.Close)
	if err := bridge.Connect(ctx, false); err != nil {
		t.Fatal(err)
	}
	generation := bridge.Generation()
	for index, expected := range []string{"state", "state", "realtime"} {
		select {
		case event := <-observed:
			if event.Type != expected || event.Generation != generation {
				t.Fatal("an invalid frame was forwarded or its session identity was lost")
			}
			if index == 2 && string(event.Data) != `{"sequence":7}` {
				t.Fatal("observer changed original validated event bytes")
			}
		case <-ctx.Done():
			t.Fatal("observer did not deliver the validated event sequence")
		}
	}
	if bridge.Snapshot().Settings.Language != "en" {
		t.Fatal("valid state event was not applied")
	}
	select {
	case <-observed:
		t.Fatal("invalid observer frames escaped validation")
	default:
	}
	bridge.Disconnect()
	if bridge.Generation() <= generation || bridge.Status() != contracts.ConnectionStatusOffline {
		t.Fatal("disconnect retained the observer generation")
	}
	select {
	case <-tunnel.Done():
	default:
		t.Fatal("disconnect did not stop its observer tunnel")
	}
}

func TestBridgeObserverDialFailureRetiresOnlyItsOwnLiveSession(t *testing.T) {
	_, directory := ownedLifecycleFixture(t, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	changed := make(chan struct{}, 16)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/session":
			_, _ = writer.Write([]byte(`{"token":"isolated-event-token"}`))
		case "/api/state":
			_ = json.NewEncoder(writer).Encode(bridgeStateFixture())
		default:
			writer.WriteHeader(http.StatusForbidden)
		}
	}))
	t.Cleanup(server.Close)
	tunnel := &tunnelFixture{endpoint: server.URL, done: make(chan struct{})}
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory, HTTP: server.Client(),
		OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
		Changed: func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bridge.Close)
	if err := bridge.Connect(ctx, false); err != nil {
		t.Fatal(err)
	}
	for bridge.Status() != contracts.ConnectionStatusOffline {
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("failed observer left the bridge online")
		}
	}
	if bridge.Snapshot().Worker.Status != contracts.ConnectionStatusOnline {
		t.Fatal("observer failure erased the last confirmed worker snapshot")
	}
	select {
	case <-tunnel.Done():
	default:
		t.Fatal("failed observer leaked its tunnel")
	}
}
