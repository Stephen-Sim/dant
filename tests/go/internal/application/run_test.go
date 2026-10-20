package application

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type fixtureService struct {
	start chan struct{}
	close chan struct{}
	once  sync.Once
}

func (service *fixtureService) Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte("fixture")) })
}

func (service *fixtureService) Start() { close(service.start) }
func (service *fixtureService) Close() { service.once.Do(func() { close(service.close) }) }

type fixtureDeploymentService struct {
	fixtureService
	deploys int
	result  error
}

func (service *fixtureDeploymentService) DeployWorker(context.Context) error {
	service.deploys++
	return service.result
}

func serviceEndpoint(t *testing.T, address string) config.Endpoint {
	t.Helper()
	host, rawPort, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}

	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}

	return config.Endpoint{Host: host, Port: port}
}

func TestBusyEndpointFailsBeforeAnyServiceConstructorOrDataWrite(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	for _, role := range []config.Role{config.RoleController, config.RoleWorker} {
		t.Run(string(role), func(t *testing.T) {
			data := filepath.Join(t.TempDir(), "data")
			startup := config.Startup{
				Role:    role,
				DataDir: data,
				Listen:  serviceEndpoint(t, listener.Addr().String()),
			}
			constructed := false
			constructor := func(context.Context, config.Startup, string) (service, error) {
				constructed = true
				return nil, os.Mkdir(data, 0o700)
			}

			if err := runService(context.Background(), startup, "fixture", bytes.NewReader(nil), io.Discard, constructor); err == nil {
				t.Fatal("busy endpoint accepted")
			}
			if constructed {
				t.Fatal("service constructed before endpoint reservation")
			}
			if _, err := os.Lstat(data); !os.IsNotExist(err) {
				t.Fatal("busy endpoint changed data")
			}
		})
	}
}

func TestFailedConstructionReleasesReservedEndpoint(t *testing.T) {
	startup := config.Startup{Role: config.RoleController, Listen: config.Endpoint{Host: "127.0.0.1"}}
	failure := errors.New("fixture_constructor_failed")
	var address string
	constructor := func(_ context.Context, configured config.Startup, _ string) (service, error) {
		address = net.JoinHostPort(configured.Listen.Host, strconv.Itoa(configured.Listen.Port))
		return nil, failure
	}

	// Reserve a concrete free port so the post-failure bind tests the same endpoint.
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	startup.Listen = serviceEndpoint(t, reserved.Addr().String())
	_ = reserved.Close()

	if err := runService(context.Background(), startup, "fixture", bytes.NewReader(nil), io.Discard, constructor); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal("failed construction retained endpoint", err)
	}
	_ = listener.Close()
}

func TestExplicitWorkerDeploymentIsOneShotAndNeverStartsTheServiceLoop(t *testing.T) {
	for _, failure := range []error{nil, errors.New("fixture_deployment_unconfirmed")} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			instance := &fixtureDeploymentService{
				fixtureService: fixtureService{start: make(chan struct{}), close: make(chan struct{})},
				result:         failure,
			}
			startup := config.Startup{
				Role:         config.RoleController,
				DeployWorker: true,
				Listen:       config.Endpoint{Host: "127.0.0.1"},
			}
			constructor := func(context.Context, config.Startup, string) (service, error) { return instance, nil }
			var output bytes.Buffer

			if err := runService(context.Background(), startup, "fixture", bytes.NewReader(nil), &output, constructor); !errors.Is(err, failure) {
				t.Fatal(err)
			}
			if instance.deploys != 1 || output.Len() != 0 {
				t.Fatal("deployment was skipped, replayed, or advertised as a running service")
			}
			select {
			case <-instance.start:
				t.Fatal("one-shot deployment enabled background service work")
			default:
			}
			select {
			case <-instance.close:
			default:
				t.Fatal("one-shot deployment retained service ownership")
			}
		})
	}
}

func TestOrdinaryStartupDoesNotInvokeExplicitWorkerDeployment(t *testing.T) {
	instance := &fixtureDeploymentService{
		fixtureService: fixtureService{start: make(chan struct{}), close: make(chan struct{})},
	}
	startup := config.Startup{
		Role:         config.RoleController,
		ManagedInput: true,
		Listen:       config.Endpoint{Host: "127.0.0.1"},
	}
	constructor := func(context.Context, config.Startup, string) (service, error) { return instance, nil }
	if err := runService(context.Background(), startup, "fixture", bytes.NewReader(nil), io.Discard, constructor); err != nil {
		t.Fatal(err)
	}
	if instance.deploys != 0 {
		t.Fatal("ordinary startup executed the one-shot deployment command")
	}
}

func TestManagedProcessClosesServiceWhenNativePipeEnds(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	input, parent := io.Pipe()
	defer parent.Close()
	defer input.Close()
	service := &fixtureService{start: make(chan struct{}), close: make(chan struct{})}
	done := make(chan error, 1)
	var ready bytes.Buffer
	go func() { done <- serve(context.Background(), service, listener, &ready, true, input) }()
	select {
	case <-service.start:
	case <-time.After(5 * time.Second):
		t.Fatal("service did not become ready")
	}
	_ = parent.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("managed shutdown leaked")
	}
	select {
	case <-service.close:
	default:
		t.Fatal("service not closed")
	}
	if !bytes.HasPrefix(ready.Bytes(), []byte("dant listening at http://127.0.0.1:")) {
		t.Fatal("native readiness contract changed")
	}
}

func TestProcessRefusesMissingBuildMetadataBeforeStartup(t *testing.T) {
	version, source := buildinfo.Version, buildinfo.Source
	buildinfo.Version, buildinfo.Source = "", ""
	t.Cleanup(func() { buildinfo.Version, buildinfo.Source = version, source })
	if err := Run(context.Background(), []string{"--role=controller"}, bytes.NewReader(nil), io.Discard); !errors.Is(err, buildinfo.ErrMetadata) {
		t.Fatal(err)
	}
}

func TestOfflinePreparationRequiresValidBackupBeforeExistingDataWrites(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	persistence, err := store.OpenContext(context.Background(), data, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	persistence.Close()
	name := filepath.Join(data, "state.json")
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	startup := config.Startup{DataDir: data, WorkspaceRoot: filepath.Join(root, "workspace")}
	if err := prepareData(context.Background(), startup); !errors.Is(err, backups.ErrInvalid) {
		t.Fatal(err)
	}
	invalid := filepath.Join(root, "invalid.backup")
	if err := os.WriteFile(invalid, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	startup.Backup = invalid
	if err := prepareData(context.Background(), startup); err == nil {
		t.Fatal("invalid backup accepted")
	}
	after, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed validation changed existing data")
	}
	if _, err := os.Stat(filepath.Join(data, "memory")); !os.IsNotExist(err) {
		t.Fatal("failed validation started memory migration")
	}
}
