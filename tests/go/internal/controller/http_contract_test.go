package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/settings"
)

func controllerRecordedRequest(t *testing.T, app *App, token, method, route, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1:4317"+route, strings.NewReader(body))
	request.Header.Set("X-Dant-Token", token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	return response
}

func assertControllerCode(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body errorBody
	if response.Code != status || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Code != code {
		t.Fatalf("unexpected HTTP failure: status=%d code=%q; wanted status=%d code=%q", response.Code, body.Code, status, code)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("JSON error was cacheable or lacked content-type protection")
	}
}

func TestControllerServiceUpdatePauseIsDurableAndNeverStartsWorker(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	for _, action := range []string{"pause", "resume"} {
		response := controllerRecordedRequest(t, app, token, "POST", "/api/service-update", `{"action":"`+action+`"}`)
		if response.Code != 200 {
			t.Fatalf("local update preference failed: %d", response.Code)
		}
		if readConfiguration(app.options.DataDir).ServiceUpdatesPaused != (action == "pause") {
			t.Fatal("update pause preference was not persisted")
		}
	}
	for _, body := range []string{`{`, `[]`, `{"action":null}`, `{"action":"unknown"}`, `{"action":"pause","extra":true}`} {
		response := controllerRecordedRequest(t, app, token, "POST", "/api/service-update", body)
		assertControllerCode(t, response, 400, "invalid_request")
	}
	if bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("pausing automatic updates ran a worker action")
	}
}

func TestControllerRejectsMalformedLocalSettingsBeforePersistenceOrForwarding(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	forwarded := 0
	bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
		forwarded++
		return nil, errors.New("unexpected worker operation")
	}
	for _, body := range []string{
		`{"language":"unknown"}`, `{"language":null}`, `{"showWorkSummary":null}`,
		`{"showCallCaptions":0}`, `{"skipBackupOnce":false}`, `{"skipBackupOnce":true}`,
		`{"vm":[]}`, `{"vm":{"host":"bad host"},"skipBackupOnce":true}`,
	} {
		response := controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", body)
		assertControllerCode(t, response, 400, "invalid_request")
	}
	if forwarded != 0 || app.Snapshot().Settings.Language != "zh" {
		t.Fatal("invalid local preferences changed state or crossed the Worker boundary")
	}

	response := controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"notifications":true,"showWorkSummary":true,"showCallCaptions":false}`)
	if response.Code != 200 {
		t.Fatal("valid local booleans were rejected")
	}
	saved := readConfiguration(app.options.DataDir)
	if !saved.Notifications || !saved.ShowWorkSummary || saved.ShowCallCaptions {
		t.Fatal("explicit local display settings were not retained")
	}
}

func TestControllerForwardsOnlyWorkerPreferencesAfterLocalCommit(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	bridge.request = func(_ context.Context, method, route string, headers http.Header, reader io.Reader) (*http.Response, error) {
		raw, _ := io.ReadAll(reader)
		var body contracts.RawObject
		if method != "PATCH" || route != "/api/settings" || headers.Get("Content-Type") != "application/json" || json.Unmarshal(raw, &body) != nil || len(body) != 1 || string(body["voice"]) != `"fixture-voice"` {
			t.Error("local display preferences leaked into the Worker patch")
		}
		if readConfiguration(app.options.DataDir).Language != "en" {
			t.Error("local preferences were forwarded before they were committed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	}
	response := controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"language":"en","theme":"dark","voice":"fixture-voice"}`)
	if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte(`"ok":true`)) {
		t.Fatal("worker-only preferences were not forwarded")
	}
}

func TestControllerVMBindingChangesRequireValidLocalFilesAndQuiescence(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	key := filepath.Join(app.options.DataDir, "fixture-key")
	if err := os.WriteFile(key, []byte("isolated key material"), 0600); err != nil {
		t.Fatal(err)
	}
	patch, _ := json.Marshal(struct {
		VM             computer.Binding `json:"vm"`
		SkipBackupOnce bool             `json:"skipBackupOnce"`
	}{computer.Binding{Host: "fixture.invalid", User: "dant", Port: 2222, KeyPath: key}, true})
	response := controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", string(patch))
	if response.Code != 200 {
		t.Fatalf("isolated VM selection was rejected: %d", response.Code)
	}
	binding, err := computer.ReadBinding(app.options.DataDir)
	if err != nil || binding.Host != "fixture.invalid" || binding.Port != 2222 || bridge.Generation() != 1 || app.Snapshot().Settings.VM.Host != binding.Host {
		t.Fatal("VM selection did not persist and retire the previous connection")
	}

	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.state.Active = &contracts.ActiveExecution{}
	bridge.mu.Unlock()
	response = controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"vm":{"host":"replacement.invalid"},"skipBackupOnce":true}`)
	assertControllerCode(t, response, 409, "vm_pause_unconfirmed")
	retained, err := computer.ReadBinding(app.options.DataDir)
	if err != nil || retained.Host != binding.Host || bridge.Generation() != 1 {
		t.Fatal("busy worker allowed a binding replacement")
	}
}

func TestControllerProfileImportRejectsInvalidSelectionsWithoutDisconnecting(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	for _, body := range []string{`{`, `{"skipBackupOnce":false}`, `{"skipBackupOnce":true,"extra":true}`, `{"skipBackupOnce":true,"id":false}`, `{"skipBackupOnce":true,"id":"missing-profile"}`} {
		response := controllerRecordedRequest(t, app, token, "POST", "/api/vm/import", body)
		if response.Code < 400 || bridge.Generation() != 0 {
			t.Fatal("invalid profile selection succeeded or retired a valid connection")
		}
	}
}

func TestControllerDesktopRoutesKeepReadsAvailableDuringExplicitExit(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	for _, body := range []string{`{"reason":"unknown"}`, `{"leaseId":null}`, `{"leaseId":"x"}`, `{"unexpected":true}`} {
		assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", body), 400, "invalid_request")
	}
	response := controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", `{}`)
	var result DesktopResult
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.WorkPaused || !result.Unsupported || !result.NotConfigured || result.VMSuspended == nil || *result.VMSuspended {
		t.Fatal("unconfigured host exit claimed a VM suspension")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"theme":"light"}`), 409, "desktop_transition_busy")
	if response := controllerRecordedRequest(t, app, token, "GET", "/api/state", ""); response.Code != 200 {
		t.Fatal("paused desktop hid its recovery state")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/open", `{"extra":true}`), 400, "invalid_request")
	if response := controllerRecordedRequest(t, app, token, "POST", "/api/desktop/open", `{}`); response.Code != 200 || app.desktop.Phase() != contracts.DesktopPhaseIdle {
		t.Fatal("reopening did not release the desktop transition")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/cancel-exit", `{"leaseId":"unowned"}`), 409, "desktop_transition_busy")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/desktop/missing", `{}`), 404, "not_found")
	if bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("unconfigured desktop routes performed worker work")
	}
}

func TestControllerLocalInventoryAndDiagnosticsFailuresStayBounded(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	app.options.Fonts = func(context.Context) (settings.FontInventory, error) {
		return settings.FontInventory{Fonts: []string{"Fixture Sans"}, Source: "fixture"}, nil
	}
	for _, path := range []string{"/api/fonts", "/api/vm/profiles", "/api/vm/providers", "/api/notifications/pending", "/api/backups"} {
		if response := controllerRecordedRequest(t, app, token, "GET", path, ""); response.Code != 200 {
			t.Fatalf("offline inventory unavailable: %s (%d)", path, response.Code)
		}
	}
	app.options.Fonts = func(context.Context) (settings.FontInventory, error) {
		return settings.FontInventory{}, errors.New("private internal font path")
	}
	response := controllerRecordedRequest(t, app, token, "GET", "/api/fonts", "")
	assertControllerCode(t, response, 502, "request_failed")
	if strings.Contains(response.Body.String(), "private") {
		t.Fatal("raw font diagnostic escaped the HTTP boundary")
	}
	for _, path := range []string{"/api/notifications//ack", "/api/notifications/a/b/ack"} {
		assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", path, `{}`), 400, "invalid_request")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/notifications/missing/ack", `{}`), 502, "request_failed")

	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.mu.Unlock()
	for index, raw := range []string{`{`, `{"status":[],"recent":[]}`, `{"status":{},"recent":false}`, strings.Repeat(" ", 1024*1024+1)} {
		bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(raw))}, nil
		}
		response := controllerRecordedRequest(t, app, token, "GET", "/api/diagnostics", "")
		var body struct{ Worker struct{ Available bool } }
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Worker.Available {
			t.Fatalf("malformed worker diagnostics were exposed as authoritative: fixture=%d status=%d available=%t", index, response.Code, body.Worker.Available)
		}
	}
	recent := make([]json.RawMessage, 55)
	for index := range recent {
		recent[index], _ = json.Marshal(struct {
			Count int `json:"count"`
		}{index})
	}
	raw, _ := json.Marshal(struct {
		Status any               `json:"status"`
		Recent []json.RawMessage `json:"recent"`
	}{struct{}{}, recent})
	bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	}
	response = controllerRecordedRequest(t, app, token, "GET", "/api/diagnostics", "")
	var body struct {
		Worker struct {
			Available bool
			Recent    []struct{ Count int }
		}
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.Worker.Available || len(body.Worker.Recent) != 50 || body.Worker.Recent[0].Count != 5 {
		t.Fatal("worker diagnostic relay was not bounded to the latest 50 records")
	}
}

func TestControllerBackupRoutesValidateTransportAndConfirmationBeforeEffects(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	for _, fixture := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"POST", "/api/backups/missing", `{}`, 404, "not_found"},
		{"GET", "/api/backups/missing/export", ``, 404, "not_found"},
		{"POST", "/api/backups/missing/unknown", `{}`, 404, "not_found"},
		{"POST", "/api/backups/missing/restore", `{"confirmation":null}`, 400, "invalid_request"},
		{"POST", "/api/backups/missing/export", `{"passphrase":"fixture","extra":true}`, 400, "invalid_request"},
		{"POST", "/api/backups/missing/export", `{}`, 400, "invalid_request"},
		{"POST", "/api/backups/import", `{}`, 400, "invalid_request"},
	} {
		assertControllerCode(t, controllerRecordedRequest(t, app, token, fixture.method, fixture.path, fixture.body), fixture.status, fixture.code)
	}
	response := controllerRecordedRequest(t, app, token, "PATCH", "/api/backups/settings", `{"mode":"manual","intervalMinutes":30,"onConnect":false,"beforeVmChange":false,"retainCount":3}`)
	var status backups.Status
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &status) != nil || status.Settings.Mode != contracts.BackupModeManual || status.Settings.IntervalMinutes != 30 || status.Settings.RetainCount != 3 {
		t.Fatal("backup preferences were not returned after durable configuration")
	}
	request := httptest.NewRequest("POST", "http://127.0.0.1:4317/api/backups/import", strings.NewReader("fixture"))
	request.Header.Set("X-Dant-Token", token)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Dant-Backup-Passphrase", "bad base64")
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	assertControllerCode(t, response, 400, "invalid_request")
	request.Header.Set("X-Dant-Backup-Passphrase", base64.StdEncoding.EncodeToString([]byte("fixture")))
	request.ContentLength = backups.PortableMaxFileBytes + 1
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	assertControllerCode(t, response, 400, "invalid_request")
}

func TestControllerStaticUIRejectsTraversalAndDoesNotNavigateForMissingAssets(t *testing.T) {
	app, _, _, _ := controllerAppFixture(t)
	for _, fixture := range []struct {
		method, path string
		status       int
		content      string
	}{
		{"GET", "/", 200, "isolated UI"},
		{"GET", "/settings/appearance", 200, "isolated UI"},
		{"HEAD", "/", 200, ""},
		{"POST", "/", 405, ""},
		{"GET", "/missing.png", 404, ""},
		{"GET", "/../controller.json", 404, ""},
		{"GET", "/back\\controller.json", 404, ""},
	} {
		request := httptest.NewRequest(fixture.method, "http://localhost:4317/", nil)
		request.URL.Path = fixture.path
		response := httptest.NewRecorder()
		app.serveStatic(response, request)
		if response.Code != fixture.status || (fixture.status == 200 && response.Body.String() != fixture.content) {
			t.Fatalf("static route contract failed for %s: %d", fixture.path, response.Code)
		}
	}
	if err := os.Remove(filepath.Join(app.options.Root, "dist", "index.html")); err != nil {
		t.Fatal(err)
	}
	response := controllerRecordedRequest(t, app, "", "GET", "/settings", "")
	if response.Code != 404 {
		t.Fatal("missing UI bundle did not fail closed")
	}
}

type controllerFailingReader struct{}

func (controllerFailingReader) Read([]byte) (int, error) {
	return 0, errors.New("isolated input failure")
}

func TestControllerJSONAndPassphraseBoundariesRejectAmbiguousInputs(t *testing.T) {
	for _, raw := range []string{`[]`, `null`, `{} {}`, `{"duplicate":1,"duplicate":2}`, strings.Repeat(" ", config.APIJSONBodyBytes+1)} {
		request := httptest.NewRequest("POST", "/", strings.NewReader(raw))
		if _, _, err := jsonRequest(request); err == nil {
			t.Fatal("invalid or oversized JSON crossed the local API boundary")
		}
	}
	request := httptest.NewRequest("POST", "/", nil)
	request.Body = io.NopCloser(controllerFailingReader{})
	if _, _, err := jsonRequest(request); err == nil || classifyHTTPError(err).status != 413 {
		t.Fatal("unreadable request body was accepted")
	}
	for _, header := range []string{"invalid", "YQ==\n", "/w==", strings.Repeat("A", base64.StdEncoding.EncodedLen(backups.PortablePassphraseMaxBytes)+1)} {
		if _, err := importPassphrase(header); !errors.Is(err, backups.ErrInvalid) {
			t.Fatal("noncanonical, non-UTF8, or oversized passphrase header accepted")
		}
	}
	if value, err := importPassphrase(base64.StdEncoding.EncodeToString([]byte("中文 fixture"))); err != nil || value != "中文 fixture" {
		t.Fatal("canonical UTF-8 passphrase was changed")
	}
}

func TestControllerVoiceKeyChangesRespectCallOwnershipAndSecretBoundary(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	bridge.mu.Lock()
	bridge.state.Call = &contracts.Call{ID: "fixture-call", Status: "connected", Provider: "subscription"}
	bridge.mu.Unlock()
	for _, method := range []string{"POST", "DELETE"} {
		assertControllerCode(t, controllerRecordedRequest(t, app, token, method, "/api/voice-key", `{"key":"fixture-key-value-123456"}`), 409, "call_active")
	}
	bridge.mu.Lock()
	bridge.state.Call = nil
	bridge.mu.Unlock()
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/voice-key", `{"key":null}`), 400, "invalid_request")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/voice-key", `{"key":"short"}`), 400, "invalid_request")
	key := "fixture-key-value-123456"
	store, err := security.NewVoiceKeyStore(app.options.DataDir, "linux", key, nil)
	if err != nil {
		t.Fatal(err)
	}
	app.voiceKeys = store
	bridge.request = func(_ context.Context, method, route string, _ http.Header, reader io.Reader) (*http.Response, error) {
		var body struct {
			APIKey string `json:"apiKey"`
		}
		if json.NewDecoder(reader).Decode(&body) != nil || body.APIKey != key || method != "POST" || route != "/api/call" {
			t.Error("API call did not receive the explicitly configured local credential")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: http.Header{}}, nil
	}
	response := controllerRecordedRequest(t, app, token, "POST", "/api/call", `{"provider":"api"}`)
	if response.Code != 200 || strings.Contains(response.Body.String(), key) {
		t.Fatal("call proxy leaked a local API credential")
	}
}

func TestControllerProxyBoundsActualJSONBytesBeforeTransportIncludingChunkedRequests(t *testing.T) {
	_, bridge, server, token := controllerAppFixture(t)
	var forwarded atomic.Int32
	var received atomic.Int64
	bridge.request = func(_ context.Context, _ string, _ string, _ http.Header, body io.Reader) (*http.Response, error) {
		forwarded.Add(1)
		raw, err := io.ReadAll(body)
		if err != nil {
			t.Error("fixture proxy could not read bounded body")
		}
		received.Store(int64(len(raw)))
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	}
	prefix, suffix := `{"text":"`, `"}`
	for _, fixture := range []struct {
		name    string
		extra   int
		chunked bool
		kind    string
		status  int
	}{
		{"exact JSON", 0, false, "application/json; charset=utf-8", 200},
		{"exact chunked JSON", 0, true, "application/json", 200},
		{"oversized JSON", 1, false, "application/json", 413},
		{"oversized chunked JSON", 1, true, "application/json", 413},
		{"opaque upload", 1, true, "application/octet-stream", 200},
		{"multipart upload", 1, true, "multipart/form-data; boundary=fixture", 200},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			wire := prefix + strings.Repeat("x", config.APIJSONBodyBytes-len(prefix)-len(suffix)+fixture.extra) + suffix
			var body io.Reader = strings.NewReader(wire)
			if fixture.chunked {
				body = io.NopCloser(body)
			}
			request, err := http.NewRequestWithContext(t.Context(), "POST", server.URL+"/api/skills", body)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("X-Dant-Token", token)
			request.Header.Set("Content-Type", fixture.kind)
			before := forwarded.Load()
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != fixture.status {
				t.Fatalf("JSON boundary status=%d wanted=%d", response.StatusCode, fixture.status)
			}
			if fixture.status == 413 {
				if forwarded.Load() != before {
					t.Fatal("oversized body reached worker transport")
				}
			} else if forwarded.Load() != before+1 || received.Load() != int64(len(wire)) {
				t.Fatal("valid or opaque body changed across proxy")
			}
		})
	}
}
