package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
)

func TestControllerSettingsReportsFailedNotificationPersistenceAndWorkerSync(t *testing.T) {
	for _, mode := range []string{"notification-save", "worker-sync"} {
		t.Run(mode, func(t *testing.T) {
			app, bridge, _, _ := controllerAppFixture(t)
			requests := 0
			if mode == "notification-save" {
				if err := os.Mkdir(filepath.Join(app.options.DataDir, "notifications.json"), 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				bridge.mu.Lock()
				bridge.status = contracts.ConnectionStatusOnline
				bridge.mu.Unlock()
				bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
					requests++
					return nil, io.ErrUnexpectedEOF
				}
			}
			err := app.patchSettings(httptest.NewRecorder(), httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{"language":"en","notifications":true}`)))
			if err == nil || readConfiguration(app.options.DataDir).Language != "en" || app.configuration.Language != "en" {
				t.Fatal("downstream failure hid a persisted local preference or returned success", err)
			}
			if mode == "notification-save" {
				if !errors.Is(err, history.ErrNotificationSave) || requests != 0 {
					t.Fatal("notification persistence failure crossed the worker boundary", err)
				}
			} else if requests != 1 || !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatal("uncertain worker preference patch was retried or concealed", err)
			}
		})
	}
}

func TestControllerConfigurationMarshalRejectsExcessiveTypedFields(t *testing.T) {
	configuration := defaultConfiguration()
	configuration.FontFamily = strings.Repeat("x", controllerConfigLimit+1)
	if _, err := configuration.MarshalJSON(); err == nil {
		t.Fatal("oversized typed configuration bypassed its JSON object boundary")
	}
}

func TestControllerAssemblyRejectsInvalidSessionPortsAndOccupiedDataDirectory(t *testing.T) {
	for _, mode := range []string{"session-port", "data-file"} {
		t.Run(mode, func(t *testing.T) {
			options := controllerIsolatedOptions(t)
			switch mode {
			case "session-port":
				options.Network.API.Port = -1
			case "data-file":
				if err := os.Remove(options.DataDir); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(options.DataDir, []byte("unrelated original"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if app, err := New(t.Context(), options); err == nil || app != nil {
				if app != nil {
					app.Close()
				}
				t.Fatal("invalid host session or occupied directory created a usable Controller")
			}
		})
	}
}
