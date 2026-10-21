package controller

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
)

func TestControllerEveryLocalAdmissionHonorsAnInFlightRestore(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	metadata, transport, changed := controllerBackupFixture(t, app, true)
	transport.restoreEntered = make(chan struct{})
	transport.restoreRelease = make(chan struct{})
	defer func() {
		close(transport.restoreRelease)
		waitControllerBackup(t, app, changed)
	}()
	preview, err := app.backups.PreviewRestore(t.Context(), metadata.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.backups.Restore(metadata.ID, preview.Confirmation); err != nil {
		t.Fatal(err)
	}
	select {
	case <-transport.restoreEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("isolated restore did not enter its owned transport")
	}
	request := func(route, body string) *http.Request {
		return httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
	}
	for _, test := range []struct {
		name string
		run  func() error
	}{
		{"desktop-exit", func() error { return app.desktopRoute(httptest.NewRecorder(), request("/api/desktop/exit", `{}`)) }},
		{"import-profile", func() error {
			return app.importProfile(httptest.NewRecorder(), request("/api/vm/import", `{"id":"candidate"}`))
		}},
		{"change-binding", func() error { return app.patchSettings(httptest.NewRecorder(), request("/api/settings", `{"vm":{}}`)) }},
		{"manual-connect", func() error { return app.manualConnect(httptest.NewRecorder(), request("/api/connect", `{}`), false) }},
		{"connect", func() error { return app.connect(t.Context(), false, false) }},
		{"prepare", func() error { return app.prepareConnection(t.Context()) }},
		{"provision", func() error { return app.route(httptest.NewRecorder(), request("/api/provision", `{}`)) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			wanted := backups.ErrBusy
			if test.name == "provision" {
				wanted = backups.ErrBeforeVMChange
			}
			if err := test.run(); !errors.Is(err, wanted) {
				t.Fatal("in-flight restore allowed another mutating admission", err)
			}
		})
	}
	if transport.restores.Load() != 1 || bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("blocked local admission repeated restoration or crossed the worker boundary")
	}
}

func TestControllerLocalHelpersRejectMalformedAndUnpersistableInputsBeforeChangingBinding(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	for _, test := range []struct {
		method, route, body string
		run                 func(http.ResponseWriter, *http.Request) error
	}{
		{http.MethodPost, "/api/desktop/exit", `{`, app.desktopRoute},
		{http.MethodPost, "/api/desktop/open", `{"reason":"exit"}`, app.desktopRoute},
		{http.MethodPost, "/api/vm/import", `{`, app.importProfile},
		{http.MethodPost, "/api/vm/import", `{"unexpected":true}`, app.importProfile},
		{http.MethodPost, "/api/vm/import", `{"id":"missing","skipBackupOnce":false}`, app.importProfile},
		{http.MethodPost, "/api/vm/import", `{"id":17,"skipBackupOnce":true}`, app.importProfile},
		{http.MethodPost, "/api/vm/import", `{"id":"missing","skipBackupOnce":true}`, app.importProfile},
		{http.MethodPatch, "/api/settings", `{`, app.patchSettings},
	} {
		if err := test.run(httptest.NewRecorder(), httptest.NewRequest(test.method, test.route, strings.NewReader(test.body))); err == nil {
			t.Fatal("malformed local helper input was accepted", test.route)
		}
	}
	key := filepath.Join(app.options.DataDir, "fixture-key")
	if err := os.WriteFile(key, []byte("isolated fixture key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(app.options.DataDir, "vm.json"), 0700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(struct {
		VM             computer.Binding `json:"vm"`
		SkipBackupOnce bool             `json:"skipBackupOnce"`
	}{computer.Binding{Host: "fixture.invalid", User: "dant", Port: 22, KeyPath: key}, true})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(string(body)))
	if err := app.patchSettings(httptest.NewRecorder(), request); err == nil {
		t.Fatal("unpersistable VM binding was reported saved")
	}
	if bridge.Generation() != 0 || bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("rejected binding change retired or operated the existing connection")
	}
	if _, err := computer.ReadBinding(app.options.DataDir); err == nil {
		t.Fatal("failed binding persistence invented a usable connection")
	}
}
