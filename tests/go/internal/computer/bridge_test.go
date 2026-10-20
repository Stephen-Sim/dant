package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/coder/websocket"
)

type tunnelFixture struct {
	endpoint string
	done     chan struct{}
	once     sync.Once
}

func (tunnel *tunnelFixture) Endpoint() string      { return tunnel.endpoint }
func (tunnel *tunnelFixture) Done() <-chan struct{} { return tunnel.done }
func (tunnel *tunnelFixture) Stop()                 { tunnel.once.Do(func() { close(tunnel.done) }) }
func bridgeStateFixture() contracts.WorkerSnapshot {
	return contracts.WorkerSnapshot{Mode: "fixture-worker", Worker: contracts.WorkerState{Status: contracts.ConnectionStatusOnline}, Messages: []*contracts.ChatMessage{}, WorkTasks: []contracts.WorkRecord{}, Queue: []string{}, Completions: []contracts.Completion{}, Extra: contracts.RawObject{"computer": json.RawMessage(`{"status":"dant","sessionId":null,"expiresAt":0}`)}}
}

func newBridgeFixture(t *testing.T, state func() contracts.WorkerSnapshot, handler http.HandlerFunc) *VMBridge {
	t.Helper()
	_, directory := ownedLifecycleFixture(t, nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/session":
			json.NewEncoder(writer).Encode(struct {
				Token string `json:"token"`
			}{"fixture-vm-token"})
		case "/api/state":
			if request.Header.Get("X-Dant-Token") != "fixture-vm-token" {
				t.Error("worker token not supplied")
			}
			json.NewEncoder(writer).Encode(state())
		case "/events":
			connection, err := websocket.Accept(writer, request, nil)
			if err != nil {
				return
			}
			defer connection.CloseNow()
			_, _, _ = connection.Read(request.Context())
		default:
			handler(writer, request)
		}
	}))
	t.Cleanup(server.Close)
	bridge, err := NewBridge(BridgeOptions{Context: context.Background(), DataDir: directory, HTTP: server.Client(), OpenTunnel: func(context.Context, Binding) (Tunnel, error) {
		return &tunnelFixture{endpoint: server.URL, done: make(chan struct{})}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bridge.Close)
	if err := bridge.Connect(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	return bridge
}

func TestBridgeUsesWorkerCredentialAndStreamsOriginalBytesWithoutNavigation(t *testing.T) {
	content := bytes.Repeat([]byte{0, 0xff, 'a'}, 50000)
	bridge := newBridgeFixture(t, bridgeStateFixture, func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Dant-Token") != "fixture-vm-token" || request.URL.Query().Get("token") != "" || request.Header.Get("Cookie") != "" {
			t.Error("host credentials leaked to worker")
		}
		writer.Header().Set("Content-Disposition", `attachment; filename="fixture.bin"`)
		writer.Write(content)
	})
	response, err := bridge.Request(context.Background(), "GET", "/api/file?token=desktop-secret", http.Header{"X-Dant-Token": []string{"desktop-secret"}, "Cookie": []string{"host-secret"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	actual, err := io.ReadAll(response.Body)
	if err != nil || !bytes.Equal(actual, content) || response.Header.Get("Content-Disposition") == "" {
		t.Fatal("attachment body was truncated or changed")
	}
	for _, route := range []string{"https://outside.invalid/api/state", "//outside.invalid/api/state", "/not-api"} {
		if _, err := bridge.Request(context.Background(), "GET", route, nil, nil); err == nil {
			t.Fatal("non-worker route accepted")
		}
	}
}

func TestBridgeUnknownPauseIsDurableAndNotReplayed(t *testing.T) {
	var posts atomic.Int32
	state := bridgeStateFixture()
	state.Call = &contracts.Call{ID: "fixture-call", Status: "connected", Provider: "native"}
	bridge := newBridgeFixture(t, func() contracts.WorkerSnapshot { return state }, func(writer http.ResponseWriter, request *http.Request) {
		posts.Add(1)
		connection, _, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		connection.Close()
	})
	if err := bridge.PauseWorkForUpdate(context.Background(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) {
		t.Fatal("unknown pause result not retained")
	}

	if pending, err := bridge.pauseReceipt(context.Background(), mustBinding(t, bridge), "read"); err != nil || !pending {
		t.Fatal("pause reservation was not durable")
	}

	if err := bridge.PauseWorkForUpdate(context.Background(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || posts.Load() != 1 {
		t.Fatal("unknown pause was resent instead of read-reconciled")
	}
}

func mustBinding(t *testing.T, bridge *VMBridge) Binding {
	t.Helper()
	binding, err := ReadBinding(bridge.options.DataDir)
	if err != nil {
		t.Fatal(err)
	}

	return binding
}

func TestBindingDigestPreservesSavedJSONArrayBytes(t *testing.T) {
	binding := Binding{Host: "192.0.2.1", User: "dant", Port: 22, KeyPath: "C:\\A&B\u2028key", KnownHosts: "C:\\known_hosts"}
	expected := "[\"192.0.2.1\",\"dant\",22,\"C:\\\\A&B\u2028key\",\"C:\\\\known_hosts\"]"
	if BindingIdentity(binding) != expected {
		t.Fatal("legacy identity escaping changed")
	}
}
