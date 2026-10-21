package application

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
)

func processBuildFixture(t *testing.T) {
	t.Helper()
	version, source := buildinfo.Version, buildinfo.Source
	buildinfo.Version, buildinfo.Source = "0.4.7-beta.19", strings.Repeat("a", 40)
	t.Cleanup(func() { buildinfo.Version, buildinfo.Source = version, source })
}

func processHostFixture(t *testing.T) processHost {
	t.Helper()
	root := t.TempDir()
	return processHost{
		working:     func() (string, error) { return root, nil },
		executable:  func() (string, error) { return filepath.Join(root, "runtime", "dant-core"), nil },
		home:        func() (string, error) { return filepath.Join(root, "dynamic-home"), nil },
		hostname:    func() (string, error) { return "synthetic-host", nil },
		account:     func() (*user.User, error) { return &user.User{Username: "synthetic-user"}, nil },
		environment: func() []string { return []string{} },
	}
}

func TestProcessHostObservationFailureNeverConstructsOrPreparesAService(t *testing.T) {
	processBuildFixture(t)
	for _, mode := range []string{"working", "executable", "home", "hostname", "account", "configuration", "backup-home"} {
		t.Run(mode, func(t *testing.T) {
			host := processHostFixture(t)
			fail := func() (string, error) { return "", errors.New("private host observation") }
			args := []string{"--role=controller"}
			switch mode {
			case "working":
				host.working = fail
			case "executable":
				host.executable = fail
			case "home", "backup-home":
				host.home = fail
			case "hostname":
				host.hostname = fail
			case "account":
				host.account = func() (*user.User, error) { return nil, errors.New("private account lookup") }
			case "configuration":
				args = []string{"--role=future"}
			}
			if mode == "backup-home" {
				args = []string{"--role=backup-cli", "invalid"}
			}
			constructed, prepared := 0, 0
			err := runApplication(t.Context(), args, bytes.NewReader(nil), io.Discard, host,
				func(context.Context, config.Startup, string) (service, error) {
					constructed++
					return nil, errors.New("unexpected constructor")
				},
				func(context.Context, config.Startup) error {
					prepared++
					return errors.New("unexpected worker preparation")
				},
			)
			if !errors.Is(err, config.ErrStartup) || constructed != 0 || prepared != 0 || strings.Contains(err.Error(), "private") {
				t.Fatal("invalid host observation reached a service or exposed account metadata", err)
			}
		})
	}
}

func TestProcessStartupCapturesDynamicPathsAndKeepsPrepareSeparateFromService(t *testing.T) {
	processBuildFixture(t)
	for _, role := range []config.Role{config.RoleController, config.RolePrepareWorker} {
		t.Run(string(role), func(t *testing.T) {
			host := processHostFixture(t)
			root, _ := host.working()
			home, _ := host.home()
			workspace := filepath.Join(root, "different-workspace")
			data := filepath.Join(root, "different-data")
			executable, _ := host.executable()
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := serviceEndpoint(t, listener.Addr().String()).Port
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			host.environment = func() []string { return []string{"DANT_PORT=" + strconv.Itoa(port)} }
			failure := errors.New("synthetic initialization failure")
			constructed, prepared := 0, 0
			verify := func(startup config.Startup) {
				t.Helper()
				if startup.Root != root || startup.Home != home || startup.WorkspaceRoot != workspace || startup.DataDir != data || startup.RuntimeID != "vm:synthetic-host:synthetic-user" || startup.Role != role {
					t.Fatal("startup replaced captured paths or execution role")
				}
			}
			args := []string{"--role=" + string(role), "--data-dir=" + data, "--workspace-root=" + workspace}
			err = runApplication(t.Context(), args, bytes.NewReader(nil), io.Discard, host,
				func(_ context.Context, startup config.Startup, actualExecutable string) (service, error) {
					constructed++
					verify(startup)
					if actualExecutable != executable {
						t.Fatal("constructor lost the captured executable")
					}
					return nil, failure
				},
				func(_ context.Context, startup config.Startup) error {
					prepared++
					verify(startup)
					return failure
				},
			)
			if !errors.Is(err, failure) || (role == config.RoleController && (constructed != 1 || prepared != 0)) || (role == config.RolePrepareWorker && (constructed != 0 || prepared != 1)) {
				t.Fatal("process startup crossed role boundaries or repeated initialization", err)
			}
		})
	}
}

func TestProcessChildRolesRejectMalformedInputBeforeAnyHostService(t *testing.T) {
	processBuildFixture(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, args := range [][]string{
		{"--role=backup-transform", "unexpected"},
		{"--role=backup-transform"},
		{"--role=backup-cli", "invalid"},
	} {
		err := Run(t.Context(), args, strings.NewReader("{}"), io.Discard)
		if err == nil || (!errors.Is(err, config.ErrStartup) && !errors.Is(err, backups.ErrInvalid)) {
			t.Fatal("malformed child role started a host service", err)
		}
	}
}

type readinessFailureWriter struct{}

func (readinessFailureWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestReadinessWriteFailureClosesServiceBeforeItCanStart(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	instance := &fixtureService{start: make(chan struct{}), close: make(chan struct{})}
	if err := serve(t.Context(), instance, listener, readinessFailureWriter{}, false, bytes.NewReader(nil)); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("native readiness failure was hidden", err)
	}
	select {
	case <-instance.close:
	default:
		t.Fatal("readiness failure retained service ownership")
	}
	select {
	case <-instance.start:
		t.Fatal("service started before native readiness was confirmed")
	default:
	}
}
