package controller

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

func TestControllerLocalMutationFailuresNeverAdvertisePersistenceOrForwardToTheWorker(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	for _, test := range []struct {
		method, route, body string
		status              int
	}{
		{"POST", "/api/provision", `{`, 400},
		{"POST", "/api/provision", `{}`, 502},
		{"POST", "/api/voice-key", `{`, 400},
		{"POST", "/api/call", `{`, 400},
		{"PATCH", "/api/backups/settings", `{`, 400},
		{"PATCH", "/api/backups/settings", `{"unknown":true}`, 502},
		{"POST", "/api/backups/missing/restore", `{`, 400},
		{"POST", "/api/backups/missing/restore", `{"confirmation":"not-current"}`, 502},
		{"POST", "/api/backups/missing/preview", `{}`, 409},
		{"POST", "/api/backups/missing/export", `{"passphrase":"a sufficiently long synthetic password"}`, 409},
	} {
		response := controllerRecordedRequest(t, app, token, test.method, test.route, test.body)
		if response.Code != test.status {
			t.Fatalf("invalid local request returned %d for %s; expected %d", response.Code, test.route, test.status)
		}
	}
	if bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("invalid local request admitted a worker operation")
	}
	if err := os.Mkdir(filepath.Join(app.options.DataDir, "controller.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ method, route, body string }{
		{"PATCH", "/api/settings", `{"language":"en"}`},
		{"POST", "/api/service-update", `{"action":"pause"}`},
	} {
		response := controllerRecordedRequest(t, app, token, test.method, test.route, test.body)
		if response.Code < 400 || strings.Contains(response.Body.String(), app.options.DataDir) {
			t.Fatal("failed local persistence was reported as saved or exposed a private path")
		}
	}
	if app.configuration.Language != "zh" || app.configuration.ServiceUpdatesPaused {
		t.Fatal("failed persistence advanced the in-memory preference projection")
	}
}

func TestControllerInstallLeaseAndManualConnectionGuardsDoNotAdmitDuplicateWork(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	app.mu.Lock()
	app.manual = true
	app.mu.Unlock()
	response := controllerRecordedRequest(t, app, token, http.MethodPost, "/api/connect", `{}`)
	assertControllerCode(t, response, 409, codeDesktopBusy)
	app.mu.Lock()
	app.manual = false
	app.mu.Unlock()
	app.lease.Close()
	app.lease = updates.NewInstallLease(updates.LeaseOptions{
		Snapshot: func() updates.InstallationSnapshot {
			return updates.InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusIdle, Worker: emptyWorkerSnapshot()}
		},
		Refresh: func(context.Context) error { return nil },
	})
	if _, err := app.lease.Acquire(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, http.MethodPost, "/api/messages", `{"text":"must remain unsubmitted"}`), 409, codeDesktopBusy)
	if _, err := app.enterConnection(); !errors.Is(err, updates.ErrInstallationDeferred) {
		t.Fatal("installation lease allowed a new connection admission", err)
	}
	if err := app.prepareConnection(t.Context()); !errors.Is(err, updates.ErrInstallationDeferred) {
		t.Fatal("installation lease allowed deployment preparation", err)
	}
	if err := app.connect(t.Context(), false, false); !errors.Is(err, updates.ErrInstallationDeferred) {
		t.Fatal("installation lease allowed a parallel connection", err)
	}
	if bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("guarded operations crossed the worker boundary")
	}
}

func TestControllerDiagnosticsRejectsChangedLocalLogAuthorityWithoutDisclosingItsPath(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	if err := app.diagnostics.Close(); err != nil {
		t.Fatal(err)
	}
	directory := app.diagnostics.Status().Directory
	if err := os.Rename(directory, directory+"-preserved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directory, []byte("synthetic changed log authority"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := controllerRecordedRequest(t, app, token, http.MethodGet, "/api/diagnostics", "")
	assertControllerCode(t, response, 502, codeRequestFailed)
	if strings.Contains(response.Body.String(), directory) {
		t.Fatal("diagnostic failure exposed its private source path")
	}
	if err := app.desktopRoute(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/desktop/unavailable", strings.NewReader(`{}`))); err == nil {
		t.Fatal("unknown desktop action succeeded")
	}
}
