package controller

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

func controllerIsolatedOptions(t *testing.T) Options {
	t.Helper()
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	host, err := platform.New("linux", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := computer.NewProfiles(computer.ProfileOptions{DataDir: data, ProjectRoot: root, RegistryFile: filepath.Join(root, "profiles.json"), Owner: "isolated-owner"})
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		Root: root, DataDir: data, Version: "0.4.7-beta.15", BuildSource: strings.Repeat("a", 40),
		Host: host, Profiles: profiles, PrepareOnly: true,
		Prepare: func(context.Context, computer.Binding) error { return nil },
		BridgeFactory: func(options computer.BridgeOptions) (Bridge, error) {
			return &controllerBridgeFixture{options: options, status: contracts.ConnectionStatusOffline, state: emptyWorkerSnapshot()}, nil
		},
	}
}

func TestControllerConstructorRejectsInvalidOwnershipBeforeStartingServices(t *testing.T) {
	for _, fixture := range []struct {
		name       string
		change     func(*Options)
		nilContext bool
		cancelled  bool
	}{
		{"nil context", func(*Options) {}, true, false},
		{"relative root", func(options *Options) { options.Root = "relative" }, false, false},
		{"relative data", func(options *Options) { options.DataDir = "relative" }, false, false},
		{"missing version", func(options *Options) { options.Version = "" }, false, false},
		{"cancelled owner", func(*Options) {}, false, true},
		{"missing root", func(options *Options) { options.Root = filepath.Join(options.Root, "missing") }, false, false},
		{"invalid port", func(options *Options) { options.Environment = map[string]string{"DANT_PORT": "invalid"} }, false, false},
		{"malformed notification state", func(options *Options) {
			if err := os.WriteFile(filepath.Join(options.DataDir, "notifications.json"), []byte(`{`), 0600); err != nil {
				t.Fatal(err)
			}
		}, false, false},
		{"vault path occupied", func(options *Options) {
			if err := os.WriteFile(filepath.Join(options.DataDir, "vm-backups"), []byte("ordinary file"), 0600); err != nil {
				t.Fatal(err)
			}
		}, false, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			options := controllerIsolatedOptions(t)
			fixture.change(&options)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if fixture.cancelled {
				cancel()
			}
			var owner context.Context = ctx
			if fixture.nilContext {
				owner = nil
			}
			app, err := New(owner, options)
			if err == nil || app != nil {
				if app != nil {
					app.Close()
				}
				t.Fatal("invalid assembly boundary created a usable Controller")
			}
			if _, err := os.Stat(filepath.Join(options.DataDir, "state.json")); !os.IsNotExist(err) {
				t.Fatal("failed Controller construction created conversation authority")
			}
		})
	}
}

func TestControllerConstructorCancelsPartiallyInitializedBridgeOwner(t *testing.T) {
	options := controllerIsolatedOptions(t)
	var captured context.Context
	options.BridgeFactory = func(value computer.BridgeOptions) (Bridge, error) {
		captured = value.Context
		return nil, computer.ErrBridgeOffline
	}
	app, err := New(context.Background(), options)
	if !errors.Is(err, computer.ErrBridgeOffline) || app != nil || captured == nil || captured.Err() == nil {
		t.Fatal("failed host assembly leaked its long-lived bridge owner")
	}
}

func TestControllerDefaultHostAndBridgeAssemblyIsPassiveAndUsesIsolatedProfiles(t *testing.T) {
	options := controllerIsolatedOptions(t)
	home := filepath.Join(options.Root, "isolated-home")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	options.Host = platform.Host{}
	options.Profiles = nil
	options.BridgeFactory = nil
	options.Environment = map[string]string{
		"LOCALAPPDATA":         home,
		"DANT_VM_PROFILE_DIR":  filepath.Join(options.Root, "missing-profile"),
		"DANT_VM_PROFILE_DIRS": `["` + filepath.ToSlash(filepath.Join(options.Root, "another-missing-profile")) + `"]`,
	}
	app, err := New(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	app.Start()
	if app.started || app.bridge.Status() == contracts.ConnectionStatusOnline || app.backgroundAllowed() {
		t.Fatal("default prepare-only host assembly connected or started execution")
	}
	state := app.Snapshot()
	if state.Mode != "vm-controller" || len(state.Messages) != 0 || len(state.WorkTasks) != 0 {
		t.Fatal("host constructor invented worker state")
	}
}

func TestControllerInstallationLeaseOwnsExitAndCannotBeCancelledByAnotherRequest(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/updates/install-lease", `{"unexpected":true}`), 400, "invalid_request")
	response := controllerRecordedRequest(t, app, token, "POST", "/api/updates/install-lease", `{}`)
	var lease updates.LeaseReceipt
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &lease) != nil || lease.LeaseID == "" || app.desktop.Phase() != contracts.DesktopPhasePaused {
		t.Fatal("installation did not reserve and pause the desktop")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/open", `{}`), 409, "desktop_transition_busy")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", `{"reason":"install"}`), 409, "desktop_transition_busy")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/cancel-exit", `{}`), 409, "desktop_transition_busy")
	body, _ := json.Marshal(struct {
		Reason  string `json:"reason"`
		LeaseID string `json:"leaseId"`
	}{"install", lease.LeaseID})
	response = controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", string(body))
	var result struct {
		DesktopResult
		LeaseID   string `json:"leaseId"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.OK || result.LeaseID != lease.LeaseID || result.ExpiresAt <= 0 {
		t.Fatal("protected exit lost its exact installation lease")
	}
	response = controllerRecordedRequest(t, app, token, "POST", "/api/desktop/cancel-exit", string(body))
	if response.Code != 200 || app.lease.Current() != nil || app.desktop.Blocked() || bridge.connects != 0 {
		t.Fatal("owner cancellation failed to release lease or connected an unconfigured worker")
	}
	response = controllerRecordedRequest(t, app, token, "POST", "/api/updates/install-lease", `{}`)
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &lease) != nil {
		t.Fatal("released installation reservation could not be reacquired")
	}
	response = controllerRecordedRequest(t, app, token, "DELETE", "/api/updates/install-lease/"+lease.LeaseID, "")
	if response.Code != http.StatusOK || app.lease.Current() != nil || app.desktop.Blocked() {
		t.Fatal("explicit lease release did not release its local desktop pause")
	}
}
