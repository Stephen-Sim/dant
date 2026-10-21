package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controllerTargetFailureTransport struct {
	*controllerBackupTransport
	target func(context.Context, bool) (backups.Target, error)
}

func (transport *controllerTargetFailureTransport) Target(ctx context.Context, refresh bool) (backups.Target, error) {
	return transport.target(ctx, refresh)
}

func TestControllerBackupStatusFailureRetainsSavedSettingsWithoutInventingSuccess(t *testing.T) {
	for _, configure := range []bool{false, true} {
		t.Run(map[bool]string{false: "status", true: "settings"}[configure], func(t *testing.T) {
			app, bridge, _, token := controllerAppFixture(t)
			vault, err := backups.NewVault(backups.VaultOptions{DataDir: app.options.DataDir, Protection: controllerSecretProtection{}})
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			transport := &controllerTargetFailureTransport{
				controllerBackupTransport: &controllerBackupTransport{},
				target: func(context.Context, bool) (backups.Target, error) {
					calls++
					return backups.Target{}, context.DeadlineExceeded
				},
			}
			manager, err := backups.NewManager(backups.ManagerOptions{
				Context: app.ctx, DataDir: app.options.DataDir, Vault: vault, Transport: transport,
			})
			if err != nil {
				t.Fatal(err)
			}
			app.backups.Close()
			app.backups = manager
			method, route, body := http.MethodGet, "/api/backups", ""
			if configure {
				method, route, body = http.MethodPatch, "/api/backups/settings", `{"intervalMinutes":125}`
			}
			response := controllerRecordedRequest(t, app, token, method, route, body)
			assertControllerCode(t, response, http.StatusGatewayTimeout, "request_timeout")
			if calls != 1 || bridge.connects != 0 || manager.Busy() {
				t.Fatal("failed backup status was retried or started an operation")
			}
			if configure {
				raw, err := os.ReadFile(filepath.Join(app.options.DataDir, "backup-settings.json"))
				if err != nil || !strings.Contains(string(raw), `"intervalMinutes":125`) {
					t.Fatal("failed status response lost its already committed preferences", err)
				}
			}
			manager.Close()
			response = controllerRecordedRequest(t, app, token, http.MethodPost, "/api/backups/run", `{}`)
			assertControllerCode(t, response, http.StatusConflict, "backup_running")
		})
	}
}

func TestControllerVMChangeCannotBypassAnUnconfirmedBackupOrWorkerStop(t *testing.T) {
	for _, stage := range []string{"backup-before-profile", "backup-before-binding", "worker-still-running"} {
		t.Run(stage, func(t *testing.T) {
			app, bridge, _, _ := controllerAppFixture(t)
			if stage == "worker-still-running" {
				bridge.status = contracts.ConnectionStatusOnline
				bridge.state = controllerQuiescentState(contracts.ConnectionStatusOnline)
				bridge.state.Queue = []string{"pending-input"}
				request := httptest.NewRequest(http.MethodPost, "/api/vm/import", strings.NewReader(`{"id":"unselected","skipBackupOnce":true}`))
				if err := app.importProfile(httptest.NewRecorder(), request); !errors.Is(err, computer.ErrPauseUnconfirmed) {
					t.Fatal("unfinished worker was detached by a profile change", err)
				}
			} else {
				key := filepath.Join(app.options.DataDir, "isolated-key")
				if err := os.WriteFile(key, []byte("fixture key placeholder"), 0600); err != nil {
					t.Fatal(err)
				}
				before, err := json.Marshal(computer.Binding{Host: "isolated.invalid", User: "dant", Port: 22, KeyPath: key})
				if err != nil {
					t.Fatal(err)
				}
				bindingFile := filepath.Join(app.options.DataDir, "vm.json")
				if err := os.WriteFile(bindingFile, before, 0600); err != nil {
					t.Fatal(err)
				}
				if stage == "backup-before-profile" {
					request := httptest.NewRequest(http.MethodPost, "/api/vm/import", strings.NewReader(`{"id":"unselected"}`))
					err = app.importProfile(httptest.NewRecorder(), request)
				} else {
					request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{"vm":{"port":2222}}`))
					err = app.patchSettings(httptest.NewRecorder(), request)
				}
				if !errors.Is(err, backups.ErrBusy) {
					t.Fatal("a required backup failure permitted the binding to change", err)
				}
				app.backups.Close()
				after, err := os.ReadFile(bindingFile)
				if err != nil || !bytes.Equal(before, after) || bridge.Generation() != 0 {
					t.Fatal("failed backup changed the connection file or its generation", err)
				}
			}
			if bridge.connects != 0 || bridge.pauses != 0 {
				t.Fatal("blocked VM change operated the connection")
			}
		})
	}
}

func TestControllerHostProtectionAndUnconfirmedVersionUseExistingBoundaries(t *testing.T) {
	for _, customPrepare := range []bool{false, true} {
		t.Run(map[bool]string{false: "unconfirmed deployer", true: "external preparation"}[customPrepare], func(t *testing.T) {
			options := controllerIsolatedOptions(t)
			options.Host.Protection = controllerSecretProtection{}
			if !customPrepare {
				options.Prepare = nil
			}
			key := filepath.Join(options.DataDir, "isolated-key")
			if err := os.WriteFile(key, []byte("fixture private key placeholder"), 0600); err != nil {
				t.Fatal(err)
			}
			binding, err := json.Marshal(computer.Binding{Host: "isolated.invalid", User: "dant", Port: 22, KeyPath: key})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(options.DataDir, "vm.json"), binding, 0600); err != nil {
				t.Fatal(err)
			}
			app, err := New(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			status, err := app.backups.Status(t.Context())
			if err != nil || status.Availability.Online || status.Availability.Supported || app.options.Protector == nil {
				t.Fatal("offline target invented confirmed version/capability or discarded host protection", err)
			}
		})
	}
}
