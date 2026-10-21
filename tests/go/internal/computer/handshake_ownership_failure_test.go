package computer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type handshakeCloseBody struct {
	io.ReadCloser
	once   sync.Once
	closed func()
}

func (body *handshakeCloseBody) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(body.closed)
	return err
}

func TestBridgeHandshakeCannotPublishAnOwnerThatChangedAtAdmissionOrAcknowledgement(t *testing.T) {
	for _, stage := range []string{"before handshake", "session response closed", "initial state published"} {
		t.Run(stage, func(t *testing.T) {
			_, directory := ownedLifecycleFixture(t, nil)
			tunnel := &tunnelFixture{endpoint: "http://127.0.0.1:4317", done: make(chan struct{})}
			var bridge *VMBridge
			var requests atomic.Int32
			transport := &bridgeHTTPContract{hook: func(request *http.Request) (*http.Response, error) {
				requests.Add(1)
				if stage == "session response closed" && request.URL.Path == "/api/session" {
					response := contractResponse(http.StatusOK, `{"token":"isolated-worker-token"}`)
					response.Body = &handshakeCloseBody{ReadCloser: response.Body, closed: bridge.Disconnect}
					return response, nil
				}
				return nil, nil
			}}
			var err error
			bridge, err = NewBridge(BridgeOptions{
				Context: t.Context(), DataDir: directory, HTTP: &http.Client{Transport: transport},
				OpenTunnel: func(context.Context, Binding) (Tunnel, error) { return tunnel, nil },
				Changed: func() {
					if stage == "before handshake" && bridge.Status() == contracts.ConnectionStatusConnecting {
						bridge.Disconnect()
					}
				},
				Event: func(event BridgeEvent) {
					if stage == "initial state published" && event.Type == "state" {
						bridge.Disconnect()
					}
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer bridge.Close()
			if err := bridge.Connect(t.Context(), false); !errors.Is(err, ErrBridgeChanged) {
				t.Fatal("retired handshake established an online connection", err)
			}
			if bridge.Status() != contracts.ConnectionStatusOffline || stage == "before handshake" && requests.Load() != 0 {
				t.Fatal("retired handshake retained authority or sent an unadmitted request")
			}
			select {
			case <-tunnel.Done():
			default:
				t.Fatal("handshake retirement leaked its captured tunnel")
			}
		})
	}
}

func TestBridgeSessionHandshakeRejectsMalformedEndpointWithoutForwardingCredentials(t *testing.T) {
	bridge, transport := newHTTPContractBridge(t, nil)
	var requests atomic.Int32
	transport.setHook(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/api/session" {
			requests.Add(1)
		}
		return nil, nil
	})
	if token, err := bridge.sessionToken(t.Context(), "http://[invalid"); !errors.Is(err, ErrSessionUnavailable) || token != "" || requests.Load() != 0 {
		t.Fatal("malformed endpoint reached authenticated transport", err)
	}
}
