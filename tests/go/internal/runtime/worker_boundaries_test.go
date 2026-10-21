package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type guestBoundaryClient func(*http.Request) (*http.Response, error)

func (client guestBoundaryClient) Do(request *http.Request) (*http.Response, error) {
	return client(request)
}

func TestOfflineWorkerCapabilitiesRejectRequestsBeforeAnyTransport(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	if _, err := worker.Request(t.Context(), "thread/read", nil); !errors.Is(err, ErrDisconnected) {
		t.Fatal("offline RPC was admitted", err)
	}
	if err := worker.Reply(t.Context(), NumericRPCID(1), json.RawMessage(`{}`)); !errors.Is(err, ErrDisconnected) {
		t.Fatal("offline reply was admitted", err)
	}
	if err := worker.ReplyError(t.Context(), NumericRPCID(1), -1, "fixture error"); !errors.Is(err, ErrDisconnected) {
		t.Fatal("offline error reply was admitted", err)
	}
	if _, _, err := worker.SubscribeEvents(); !errors.Is(err, ErrDisconnected) {
		t.Fatal("offline event subscription was created", err)
	}
	if worker.DesktopPath() == "" || worker.RuntimeID() != "vm:isolated" {
		t.Fatal("worker capability paths lost configured ownership")
	}
	worker.Close()
	if _, err := worker.Connect(t.Context()); !errors.Is(err, ErrDisconnected) {
		t.Fatal("closed worker reconnected", err)
	}
	if err := worker.CloseContext(t.Context()); err != nil {
		t.Fatal("executor-free shutdown did not join", err)
	}
}

func TestGuestRequestValidatesRoutesAndClosesFailedResponses(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	worker.status = contracts.ConnectionStatusOnline
	requests := 0
	worker.options.Client = guestBoundaryClient(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != http.MethodPost || request.URL.Path != desktopPaths.Input || request.Header.Get("Content-Type") != "application/json" {
			t.Fatal("guest route changed its validated transport contract")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("fixture"))}, nil
	})
	if _, err := worker.Guest(t.Context(), "/not-allowed", nil); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("unvalidated guest route accepted", err)
	}
	if _, err := worker.Guest(t.Context(), desktopPaths.Input, json.RawMessage(`{`)); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("malformed guest input accepted", err)
	}
	response, err := worker.Guest(t.Context(), desktopPaths.Input, json.RawMessage(`{}`))
	if err != nil || requests != 1 {
		t.Fatal("valid guest input did not use its bounded transport", err)
	}
	response.Body.Close()
	closed := false
	worker.options.Client = guestBoundaryClient(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 503, Body: &guestCloseFixture{Reader: strings.NewReader("not exposed"), close: func() { closed = true }}}, nil
	})
	if _, err := worker.Guest(t.Context(), desktopPaths.Input, json.RawMessage(`{}`)); !errors.Is(err, ErrDesktopUnavailable) || !closed {
		t.Fatal("failed guest response leaked its body or connection", err)
	}
	worker.options.Client = guestBoundaryClient(func(*http.Request) (*http.Response, error) { return nil, errors.New("isolated transport failure") })
	if _, err := worker.Guest(t.Context(), desktopPaths.Input, json.RawMessage(`{}`)); !errors.Is(err, ErrDesktopUnavailable) {
		t.Fatal("guest transport failure exposed raw causes", err)
	}
}

type guestCloseFixture struct {
	io.Reader
	close func()
}

func (body *guestCloseFixture) Close() error { body.close(); return nil }

func TestGuardedWorkerRequestDoesNotTransmitRejectedTransformation(t *testing.T) {
	fixture := newRPCFixture(t)
	worker, _ := workerFixture(t, WorkerOptions{TransformRequest: func(string, contracts.RawObject, []*contracts.ChatMessage) (contracts.RawObject, error) {
		return nil, ErrInvalidProtocol
	}})
	worker.status, worker.rpc = contracts.ConnectionStatusOnline, fixture.client
	if _, err := worker.RequestGuarded(t.Context(), "thread/read", nil, nil); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("failed transform was sent", err)
	}
	worker.options.TransformRequest = nil
	guarded := errors.New("isolated owner changed")
	if _, err := worker.RequestGuarded(t.Context(), "thread/read", nil, func() error { return guarded }); !errors.Is(err, guarded) {
		t.Fatal("rejected owner guard was sent", err)
	}
	select {
	case <-fixture.requests:
		t.Fatal("rejected input crossed the process boundary")
	default:
	}
	worker.rpc = nil
	worker.status = contracts.ConnectionStatusOffline
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := worker.Connect(cancelled); err == nil {
		t.Fatal("cancelled connection was admitted")
	}
}
