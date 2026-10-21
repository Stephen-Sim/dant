package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type bridgeHTTPContract struct {
	mu   sync.Mutex
	hook func(*http.Request) (*http.Response, error)
}

func contractResponse(status int, raw string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(raw))}
}

func (transport *bridgeHTTPContract) setHook(hook func(*http.Request) (*http.Response, error)) {
	transport.mu.Lock()
	transport.hook = hook
	transport.mu.Unlock()
}

func (transport *bridgeHTTPContract) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	hook := transport.hook
	transport.mu.Unlock()
	if hook != nil {
		if response, err := hook(request); response != nil || err != nil {
			return response, err
		}
	}
	switch request.URL.Path {
	case "/api/session":
		return contractResponse(200, `{"token":"isolated-worker-token"}`), nil
	case "/api/state":
		raw, _ := json.Marshal(bridgeStateFixture())
		return contractResponse(200, string(raw)), nil
	case "/events":
		// Keep the observer transport owned and cancellable without opening a
		// real socket or manufacturing a successful WebSocket handshake.
		<-request.Context().Done()
		return nil, request.Context().Err()
	default:
		return contractResponse(200, `{"ok":true}`), nil
	}
}

func newHTTPContractBridge(t *testing.T, hook func(*http.Request) (*http.Response, error)) (*VMBridge, *bridgeHTTPContract) {
	t.Helper()
	_, directory := ownedLifecycleFixture(t, nil)
	transport := &bridgeHTTPContract{hook: hook}
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory,
		HTTP: &http.Client{Transport: transport},
		OpenTunnel: func(context.Context, Binding) (Tunnel, error) {
			return &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bridge.Close)
	if err := bridge.Connect(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	return bridge, transport
}

func TestBridgeRejectsInvalidConfigurationAndUntrustedTunnelEndpointsBeforeHTTP(t *testing.T) {
	if _, err := NewBridge(BridgeOptions{DataDir: t.TempDir()}); !errors.Is(err, ErrBinding) {
		t.Fatal("missing owner context was accepted", err)
	}
	if _, err := NewBridge(BridgeOptions{Context: t.Context(), DataDir: "relative"}); !errors.Is(err, ErrBinding) {
		t.Fatal("relative data path was accepted", err)
	}
	for _, endpoint := range []string{
		"https://127.0.0.1:4317", "http://outside.invalid:4317", "http://192.0.2.2:4317",
		"http://user:secret@127.0.0.1:4317", "http://127.0.0.1:4317/path",
		"http://127.0.0.1:4317?token=secret", "http://127.0.0.1:4317#fragment",
		"http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "%bad",
	} {
		t.Run("untrusted endpoint", func(t *testing.T) {
			_, directory := ownedLifecycleFixture(t, nil)
			tunnel := &tunnelFixture{endpoint: endpoint, done: make(chan struct{})}
			bridge, err := NewBridge(BridgeOptions{
				Context: t.Context(), DataDir: directory,
				OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
			})
			if err != nil {
				t.Fatal(err)
			}
			defer bridge.Close()
			if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrSessionUnavailable) || bridge.Status() != contracts.ConnectionStatusOffline {
				t.Fatal("untrusted endpoint was admitted", err)
			}
			select {
			case <-tunnel.Done():
			default:
				t.Fatal("rejected tunnel was not stopped")
			}
		})
	}
}

func TestBridgeSessionHandshakeRejectsMalformedCredentialsWithinTheOwnerDeadline(t *testing.T) {
	for _, raw := range []string{
		`{`, `[]`, `{"token":"first","token":"second"}`, `{"token":42}`,
		`{"token":""}`, `{"token":"line\nfeed"}`, `{"token":"` + strings.Repeat("x", 257) + `"}`,
		strings.Repeat("x", 8193),
	} {
		t.Run("invalid credential", func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				_, directory := ownedLifecycleFixture(t, nil)
				transport := &bridgeHTTPContract{}
				transport.setHook(func(request *http.Request) (*http.Response, error) {
					return contractResponse(200, raw), nil
				})
				bridge, err := NewBridge(BridgeOptions{
					Context: t.Context(), DataDir: directory, HTTP: &http.Client{Transport: transport},
					OpenTunnel: func(context.Context, Binding) (Tunnel, error) {
						return &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}, nil
					},
				})
				if err != nil {
					t.Fatal(err)
				}
				defer bridge.Close()
				started := time.Now()
				if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrSessionUnavailable) || bridge.Status() != contracts.ConnectionStatusOffline || time.Since(started) != vmSessionReadyTimeout {
					t.Fatal("malformed credentials became online or escaped the bounded handshake", err)
				}
			})
		})
	}
}

func TestBridgePrepareAndConnectHaveOneOwnerAndCloseCancelsThePendingDeployment(t *testing.T) {
	_, directory := ownedLifecycleFixture(t, nil)
	entered := make(chan struct{})
	var tunnels atomic.Int32
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory,
		Prepare: func(ctx context.Context, binding Binding) error {
			if binding.Host != "192.0.2.1" {
				t.Error("prepare received a foreign binding")
			}
			close(entered)
			<-ctx.Done()
			return ctx.Err()
		},
		OpenTunnel: func(context.Context, Binding) (Tunnel, error) {
			tunnels.Add(1)
			return nil, ErrSessionUnavailable
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	finished := make(chan error, 1)
	go func() {
		finished <- bridge.Connect(t.Context(), true)
	}()
	<-entered
	if err := bridge.Connect(t.Context(), true); !errors.Is(err, ErrBridgeBusy) {
		t.Fatal("a second connect admitted duplicate deployment", err)
	}
	bridge.Close()
	if err := <-finished; !errors.Is(err, context.Canceled) || tunnels.Load() != 0 {
		t.Fatal("close failed to join deployment before tunnel admission", err)
	}
	if err := bridge.Prepare(t.Context()); !errors.Is(err, ErrBridgeClosed) {
		t.Fatal("closed bridge admitted another deployment", err)
	}
	if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrBridgeClosed) {
		t.Fatal("closed bridge admitted another tunnel", err)
	}
}

func TestBridgeHTTPFailuresPreserveUnknownMutationOutcomesAndNeverRetry(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			bridge, transport := newHTTPContractBridge(t, nil)
			var calls atomic.Int32
			transport.setHook(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/api/fixture" {
					calls.Add(1)
					return nil, io.ErrUnexpectedEOF
				}
				return nil, nil
			})
			_, err := bridge.Request(t.Context(), method, "/api/fixture", nil, nil)
			var outcome *RequestError
			if !errors.As(err, &outcome) || outcome.UnknownOutcome != (method != http.MethodGet && method != http.MethodHead) || calls.Load() != 1 {
				t.Fatal("transport failure was retried or its outcome was misclassified", err)
			}
			if outcome.Error() == "" {
				t.Fatal("request failure has no bounded operational code")
			}
		})
	}
}

func TestBridgeRequestKeepsCredentialsPrivateAndReleasesTheResponseLifetime(t *testing.T) {
	bridge, transport := newHTTPContractBridge(t, nil)
	var captured context.Context
	transport.setHook(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/api/fixture" {
			return nil, nil
		}
		captured = request.Context()
		if request.URL.Query().Get("token") != "" || request.URL.Query().Get("other") != "kept" || request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" || request.Header.Get("X-Dant-Token") != "isolated-worker-token" || request.Header.Get("Content-Type") != "application/octet-stream" {
			t.Error("the worker boundary forwarded desktop credentials or lost content type")
		}
		return contractResponse(200, "exact bytes"), nil
	})
	response, err := bridge.Request(t.Context(), http.MethodPost, "/api/fixture?token=desktop-secret&other=kept", http.Header{
		"Cookie": {"private"}, "Authorization": {"Bearer private"}, "X-Dant-Token": {"desktop"},
		"Content-Type": {"application/octet-stream"},
	}, strings.NewReader("input"))
	if err != nil {
		t.Fatal(err)
	}
	raw, readErr := io.ReadAll(response.Body)
	if readErr != nil || string(raw) != "exact bytes" {
		t.Fatal("the original response body changed", readErr)
	}
	if _, ok := captured.Deadline(); !ok {
		t.Fatal("ordinary worker request has no lifetime bound")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-captured.Done():
	default:
		t.Fatal("closing the response did not release its request lifetime")
	}
	for _, route := range []string{"/api/fixture?broken=%zz", "/outside", "https://outside.invalid/api/fixture", "//outside.invalid/api/fixture"} {
		if _, err := bridge.Request(t.Context(), http.MethodGet, route, nil, nil); !errors.Is(err, ErrBinding) {
			t.Fatal("invalid worker route was accepted", err)
		}
	}
	if _, err := bridge.Request(t.Context(), "invalid\nmethod", "/api/fixture", nil, nil); !errors.Is(err, ErrBinding) {
		t.Fatal("invalid HTTP method reached the transport", err)
	}
	bridge.Disconnect()
	if _, err := bridge.Request(t.Context(), http.MethodGet, "/api/fixture", nil, nil); !errors.Is(err, ErrBridgeOffline) {
		t.Fatal("a disconnected bridge reused the old session", err)
	}
}

func TestBridgeDisconnectionBeforeAnHTTPReplyCannotPublishTheOldGeneration(t *testing.T) {
	bridge, transport := newHTTPContractBridge(t, nil)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		if bridge.Status() != contracts.ConnectionStatusOnline {
			if err := bridge.Connect(t.Context(), false); err != nil {
				t.Fatal(err)
			}
		}
		transport.setHook(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path == "/api/fixture" {
				bridge.Disconnect()
				return contractResponse(200, `{"ok":true}`), nil
			}
			return nil, nil
		})
		_, err := bridge.Request(t.Context(), method, "/api/fixture", nil, nil)
		var outcome *RequestError
		if !errors.As(err, &outcome) || outcome.UnknownOutcome != (method == http.MethodPost) {
			t.Fatal("a retired session's successful bytes were applied", err)
		}
	}
}

func TestBridgeRefreshRejectsMalformedSnapshotsAndLeavesTheLastGoodCopy(t *testing.T) {
	for _, raw := range []string{`{`, `[]`, `{"worker":{"status":"future-status"}}`, `{"worker":{"status":42}}`, strings.Repeat("x", vmStateMaxBytes+1)} {
		t.Run("untrusted state", func(t *testing.T) {
			bridge, transport := newHTTPContractBridge(t, nil)
			before := bridge.Snapshot()
			transport.setHook(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/api/state" {
					return contractResponse(200, raw), nil
				}
				return nil, nil
			})
			if _, err := bridge.Refresh(t.Context()); !errors.Is(err, ErrSessionUnavailable) || bridge.Snapshot().Worker.Status != before.Worker.Status {
				t.Fatal("invalid state replaced the last valid observation", err)
			}
		})
	}
	bridge, transport := newHTTPContractBridge(t, nil)
	transport.setHook(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/api/state" {
			return contractResponse(http.StatusServiceUnavailable, `{"worker":{"status":"offline"}}`), nil
		}
		return nil, nil
	})
	if _, err := bridge.Refresh(t.Context()); !errors.Is(err, ErrSessionUnavailable) {
		t.Fatal("a failed state response was accepted", err)
	}
	copy := bridge.Snapshot()
	copy.Worker.Status = contracts.ConnectionStatusOffline
	copy.Extra["computer"] = json.RawMessage(`{"status":"human"}`)
	if bridge.Snapshot().Worker.Status != contracts.ConnectionStatusOnline || string(bridge.Snapshot().Extra["computer"]) == string(copy.Extra["computer"]) {
		t.Fatal("a caller mutated the bridge's cached authority")
	}
}

func TestBridgeMissingConfigurationAndUnavailablePreparationNeverOpenATunnel(t *testing.T) {
	var tunnels atomic.Int32
	newBridge := func(directory string) *VMBridge {
		bridge, err := NewBridge(BridgeOptions{
			Context: t.Context(), DataDir: directory,
			OpenTunnel: func(context.Context, Binding) (Tunnel, error) {
				tunnels.Add(1)
				return nil, ErrSessionUnavailable
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(bridge.Close)
		return bridge
	}
	missing := newBridge(t.TempDir())
	if err := missing.Prepare(t.Context()); err == nil {
		t.Fatal("missing configuration admitted preparation")
	}
	if err := missing.Connect(t.Context(), false); err == nil {
		t.Fatal("missing configuration admitted a connection")
	}
	_, directory := ownedLifecycleFixture(t, nil)
	configured := newBridge(directory)
	if err := configured.Prepare(t.Context()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal("an unconfigured deployment capability was treated as available", err)
	}
	if tunnels.Load() != 0 {
		t.Fatal("configuration or preparation failure started a tunnel")
	}
	if err := configured.Connect(t.Context(), false); !errors.Is(err, ErrSessionUnavailable) || tunnels.Load() != 1 {
		t.Fatal("tunnel failure was retried or misclassified", err)
	}
}

func TestBridgeCloseDuringTunnelCreationCancelsAndJoinsTheUnpublishedTunnel(t *testing.T) {
	_, directory := ownedLifecycleFixture(t, nil)
	entered := make(chan struct{})
	tunnel := &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory,
		OpenTunnel: func(ctx context.Context, _ Binding) (Tunnel, error) {
			close(entered)
			<-ctx.Done()
			return tunnel, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	finished := make(chan error, 1)
	go func() {
		finished <- bridge.Connect(t.Context(), false)
	}()
	<-entered
	bridge.Close()
	if err := <-finished; !errors.Is(err, ErrBridgeClosed) || bridge.Status() != contracts.ConnectionStatusOffline {
		t.Fatal("an unpublished tunnel became online after close", err)
	}
	select {
	case <-tunnel.Done():
	default:
		t.Fatal("close leaked the unpublished tunnel")
	}
}

func TestBridgeHandshakeTransportFailuresAreBoundedAndStopTheCapturedTunnel(t *testing.T) {
	for _, variant := range []string{"transport", "non-success", "read", "tunnel ended"} {
		t.Run(variant, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				_, directory := ownedLifecycleFixture(t, nil)
				tunnel := &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}
				if variant == "tunnel ended" {
					tunnel.Stop()
				}
				transport := &bridgeHTTPContract{hook: func(*http.Request) (*http.Response, error) {
					switch variant {
					case "transport":
						return nil, io.ErrUnexpectedEOF
					case "read":
						return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(contractFailingReader{})}, nil
					default:
						return contractResponse(http.StatusServiceUnavailable, ""), nil
					}
				}}
				bridge, err := NewBridge(BridgeOptions{
					Context: t.Context(), DataDir: directory, HTTP: &http.Client{Transport: transport},
					OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
				})
				if err != nil {
					t.Fatal(err)
				}
				defer bridge.Close()
				if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrSessionUnavailable) || bridge.Status() != contracts.ConnectionStatusOffline {
					t.Fatal("an unconfirmed handshake became online", err)
				}
				select {
				case <-tunnel.Done():
				default:
					t.Fatal("handshake failure leaked its captured tunnel")
				}
			})
		})
	}
}

type contractFailingReader struct{}

func (contractFailingReader) Read([]byte) (int, error) {
	return 0, io.ErrUnexpectedEOF
}

type contractObservedReader struct {
	io.Reader
	observe func()
	once    sync.Once
}

func (reader *contractObservedReader) Read(buffer []byte) (int, error) {
	reader.once.Do(reader.observe)
	return reader.Reader.Read(buffer)
}

func TestBridgeRefreshRechecksItsGenerationAfterReadingTheReplyBody(t *testing.T) {
	bridge, transport := newHTTPContractBridge(t, nil)
	before := bridge.Snapshot()
	changed := before
	changed.Settings.Language = "en"
	raw, _ := json.Marshal(changed)
	transport.setHook(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/api/state" {
			body := &contractObservedReader{Reader: strings.NewReader(string(raw)), observe: bridge.Disconnect}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(body)}, nil
		}
		return nil, nil
	})
	if _, err := bridge.Refresh(t.Context()); !errors.Is(err, ErrBridgeChanged) || bridge.Snapshot().Settings.Language != before.Settings.Language {
		t.Fatal("a reply body from an obsolete connection replaced the cache", err)
	}
	if _, err := bridge.Refresh(t.Context()); !errors.Is(err, ErrBridgeOffline) {
		t.Fatal("refresh after disconnect reused an obsolete connection", err)
	}
}

func TestBridgeIncompleteInitialStateAndInterruptedRefreshDoNotPublishNewAuthority(t *testing.T) {
	_, directory := ownedLifecycleFixture(t, nil)
	tunnel := &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}
	transport := &bridgeHTTPContract{hook: func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/api/state" {
			return contractResponse(200, `{"worker":{"status":"future-state"}}`), nil
		}
		return nil, nil
	}}
	bridge, err := NewBridge(BridgeOptions{
		Context: t.Context(), DataDir: directory, HTTP: &http.Client{Transport: transport},
		OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrSessionUnavailable) || bridge.Status() != contracts.ConnectionStatusOffline || bridge.Snapshot().Worker.Status != contracts.ConnectionStatusOffline {
		t.Fatal("a token without valid initial state established online authority", err)
	}
	select {
	case <-tunnel.Done():
	default:
		t.Fatal("failed initial state left the tunnel running")
	}

	online, onlineTransport := newHTTPContractBridge(t, nil)
	before := online.Snapshot()
	onlineTransport.setHook(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/api/state" {
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(contractFailingReader{})}, nil
		}
		return nil, nil
	})
	if _, err := online.Refresh(t.Context()); !errors.Is(err, ErrSessionUnavailable) || online.Snapshot().Settings.Language != before.Settings.Language {
		t.Fatal("a partial state response replaced the last valid snapshot", err)
	}
}
