package application

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

type failedAcceptListener struct{ failure error }

func (listener failedAcceptListener) Accept() (net.Conn, error) { return nil, listener.failure }
func (listener failedAcceptListener) Close() error              { return nil }
func (listener failedAcceptListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}
}

type requestContextService struct {
	fixtureService
	handler http.Handler
}

func (instance *requestContextService) Handler() http.Handler { return instance.handler }

func TestServeAcceptFailureIsJoinedAndPreservesItsResult(t *testing.T) {
	failure := errors.New("isolated listener failure")
	instance := &fixtureService{start: make(chan struct{}), close: make(chan struct{})}
	err := serve(t.Context(), instance, failedAcceptListener{failure: failure}, io.Discard, false, bytes.NewReader(nil))
	if !errors.Is(err, failure) {
		t.Fatal("listener failure was reported as successful shutdown", err)
	}
	select {
	case <-instance.close:
	default:
		t.Fatal("failed listener retained service ownership")
	}
}

func TestServeHTTPRequestsRetainTheOwnedContextThroughShutdown(t *testing.T) {
	type contextKey struct{}
	ctx, cancel := context.WithCancel(context.WithValue(t.Context(), contextKey{}, "owned-context"))
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	observed := make(chan bool, 1)
	instance := &requestContextService{
		fixtureService: fixtureService{start: make(chan struct{}), close: make(chan struct{})},
		handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			observed <- request.Context().Value(contextKey{}) == "owned-context"
			_, _ = writer.Write([]byte("isolated response"))
			cancel()
		}),
	}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, instance, listener, io.Discard, false, bytes.NewReader(nil)) }()
	select {
	case <-instance.start:
	case <-time.After(5 * time.Second):
		t.Fatal("isolated service did not start")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + listener.Addr().String() + "/owned")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "isolated response" || !<-observed {
		t.Fatal("HTTP work lost its owner or shutdown discarded the response")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not join shutdown after its owned request")
	}
}

func TestServiceConstructionAndDeploymentRejectInvalidRoles(t *testing.T) {
	processBuildFixture(t)
	for _, role := range []config.Role{config.RoleController, config.RoleWorker} {
		instance := &fixtureService{start: make(chan struct{}), close: make(chan struct{})}
		err := runService(t.Context(), config.Startup{
			Role: role, DeployWorker: true, Listen: config.Endpoint{Host: "127.0.0.1"},
		}, "isolated", bytes.NewReader(nil), io.Discard, func(context.Context, config.Startup, string) (service, error) {
			return instance, nil
		})
		if !errors.Is(err, config.ErrStartup) {
			t.Fatal("unavailable deployment capability was accepted", err)
		}
	}
	if _, err := assembleService(t.Context(), config.Startup{Role: config.RoleBackupCLI}, "isolated"); !errors.Is(err, config.ErrStartup) {
		t.Fatal("child role assembled a long-lived service", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	root := t.TempDir()
	if _, err := assembleService(cancelled, config.Startup{
		Role: config.RoleController, Root: root, DataDir: filepath.Join(root, "data"),
		Environment: map[string]string{"TZ": "UTC"},
	}, "isolated"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled Controller assembly continued", err)
	}
	if err := prepareWorker(cancelled, config.Startup{}); err == nil {
		t.Fatal("cancelled or unsupported host prepared a live worker")
	}
	constructed := false
	if err := runService(cancelled, config.Startup{}, "isolated", bytes.NewReader(nil), io.Discard, func(context.Context, config.Startup, string) (service, error) {
		constructed = true
		return nil, nil
	}); !errors.Is(err, context.Canceled) || constructed {
		t.Fatal("cancelled startup reached construction")
	}
}
