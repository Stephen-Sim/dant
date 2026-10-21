package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

func isolatedControllerWindowsHost(t *testing.T) platform.Host {
	t.Helper()
	root := t.TempDir()
	return platform.Host{
		ID: contracts.HostPlatformIdWindows, OS: "windows",
		Capabilities: platform.Capabilities{ManagedVM: true, ExistingSSH: true},
		Commands:     platform.Commands{PowerShell: filepath.Join(root, "isolated-powershell")},
		Windows: &platform.WindowsConfiguration{
			HyperVService: filepath.Join(root, "fixture-hyperv-service"),
			HyperVModule:  filepath.Join(root, "fixture-hyperv-module"),
		},
	}
}

func TestControllerProviderDetectionPropagatesRequestCancellation(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	host := isolatedControllerWindowsHost(t)
	registryCalls := 0
	providers := computer.NewProviders(host, computer.ProviderDetection{
		FileExists: func(string) bool { return false },
		ReadRegistry: func(context.Context, string) (string, error) {
			registryCalls++
			return "", computer.ErrProviderUnavailable
		},
	})
	provisioning, err := computer.NewProvisioning(computer.ProvisioningOptions{
		Context: app.ctx, ProjectRoot: app.options.Root, DataDir: app.options.DataDir, Host: host, Providers: providers,
	})
	if err != nil {
		t.Fatal(err)
	}
	app.provisioning.Close()
	app.provisioning = provisioning
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/vm/providers", nil).WithContext(ctx)
	if err := app.route(httptest.NewRecorder(), request); !errors.Is(err, context.Canceled) || registryCalls != 0 || bridge.connects != 0 {
		t.Fatal("cancelled provider discovery ran a process or lost request cancellation", err)
	}
}

func TestControllerProvisioningAdmissionReturnsStateWithoutAutomaticConnection(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	host := isolatedControllerWindowsHost(t)
	providers := computer.NewProviders(host, computer.ProviderDetection{
		FileExists: func(file string) bool {
			return file == host.Windows.HyperVService || file == host.Windows.HyperVModule
		},
		ReadRegistry: func(context.Context, string) (string, error) {
			return "", computer.ErrProviderUnavailable
		},
	})
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var commands atomic.Int32
	provisioning, err := computer.NewProvisioning(computer.ProvisioningOptions{
		Context: app.ctx, ProjectRoot: app.options.Root, DataDir: app.options.DataDir, Host: host, Providers: providers,
		Run: func(ctx context.Context, program string, arguments []string, input io.Reader) ([]byte, error) {
			commands.Add(1)
			if program != host.Commands.PowerShell || !strings.Contains(strings.Join(arguments, "|"), "prepare-vm.ps1") || input != nil {
				t.Error("provisioning did not stay inside its isolated command boundary")
			}
			close(entered)
			select {
			case <-release:
				return nil, computer.ErrProvisioningFailed
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	app.provisioning.Close()
	app.provisioning = provisioning
	response := controllerRecordedRequest(t, app, token, http.MethodPost, "/api/provision", `{"provider":"hyperv"}`)
	var state computer.ProvisioningState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Provider == nil || *state.Provider != contracts.VmProviderIdHyperV {
		t.Fatal("admitted setup did not return its exact provider state", response.Code)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("admitted setup did not reach its isolated command boundary")
	}
	app.mu.Lock()
	app.options.PrepareOnly = false
	app.started = true
	app.mu.Unlock()
	if app.backgroundAllowed() {
		t.Fatal("background connection crossed an in-flight provisioning boundary")
	}
	releaseOnce.Do(func() { close(release) })
	provisioning.Close()
	if commands.Load() != 1 || bridge.connects != 0 || bridge.pauses != 0 || app.provisioning.Snapshot().Running {
		t.Fatal("failed isolated setup replayed a command or connected a Worker")
	}
}
