package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/updates"
	"github.com/Stephen-Sim/dant/core/internal/voice/captions"
)

func TestControllerNotificationHTTPPreservesReadAcknowledgementAndLocalLanguage(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	clock := &atomic.Int64{}
	clock.Store(1000)
	hub, err := history.OpenNotificationHub(app.options.DataDir, history.NotificationOptions{Now: func() time.Time { return time.UnixMilli(clock.Load()) }, Grace: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.Configure(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	state := emptyWorkerSnapshot()
	state.ConversationID = "isolated-conversation"
	state.Messages = []*contracts.ChatMessage{{ID: "reply", Role: contracts.RoleAssistant, Text: "isolated result", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}
	state.Completions = []contracts.Completion{{ID: "completion", At: contracts.Some(1000.0), MessageIDs: []string{"reply"}}}
	if err := hub.Observe(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	clock.Store(1002)
	app.notifications = hub
	app.configuration.Language = "en"
	response := controllerRecordedRequest(t, app, token, "GET", "/api/notifications/pending", "")
	var body struct {
		Notifications []struct {
			ID       string
			Language string
		}
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || len(body.Notifications) != 1 || body.Notifications[0].ID != "completion" || body.Notifications[0].Language != "en" {
		t.Fatal("notification delivery lost its exact identity or selected language")
	}
	for range 2 {
		if response := controllerRecordedRequest(t, app, token, "POST", "/api/notifications/completion/ack", `{}`); response.Code != 200 {
			t.Fatal("notification acknowledgement was not idempotent")
		}
	}
	if len(hub.Pending()) != 0 {
		t.Fatal("acknowledged notification remained unread")
	}
	restarted, err := history.OpenNotificationHub(app.options.DataDir, history.NotificationOptions{})
	if err != nil || len(restarted.Pending()) != 0 {
		t.Fatal("acknowledged notification replayed after restart")
	}
}

type controllerReleaseHTTP func(*http.Request) (*http.Response, error)

func (request controllerReleaseHTTP) Do(value *http.Request) (*http.Response, error) {
	return request(value)
}

func TestControllerReleaseCheckIsReadOnlyAndUsesValidatedChannel(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	app.updates.Close()
	requests := 0
	app.updates = updates.New(updates.Options{Version: app.options.Version, HTTP: controllerReleaseHTTP(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != "GET" || request.URL.Host != "api.github.com" || request.Header.Get("X-Dant-Token") != "" {
			t.Error("release check crossed its read-only public API boundary")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v0.4.8","draft":false,"prerelease":false,"html_url":"https://github.com/Stephen-Sim/dant/releases/tag/v0.4.8","published_at":"2026-10-20T00:00:00Z","assets":[]}`))}, nil
	})})
	for _, path := range []string{"/api/updates", "/api/updates?channel=stable"} {
		response := controllerRecordedRequest(t, app, token, "GET", path, "")
		var body updates.CheckResult
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.UpdateAvailable || body.LatestVersion != "0.4.8" || body.Asset != nil {
			t.Fatal("validated release information was not returned without starting installation")
		}
	}
	if requests != 1 || bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("release checks bypassed cache or operated a worker")
	}
	response := controllerRecordedRequest(t, app, token, "GET", "/api/updates?channel=unknown", "")
	if response.Code != 400 {
		t.Fatal("unsupported update channel was accepted")
	}
	for _, path := range []string{"/api/version", "/api/updates"} {
		assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", path, `{}`), 405, "method_not_allowed")
	}
}

func TestControllerVoiceKeyHTTPUsesProtectedStorageAndNeverReflectsKeyBytes(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	store, err := security.NewVoiceKeyStore(app.options.DataDir, "windows", "", controllerSecretProtection{})
	if err != nil {
		t.Fatal(err)
	}
	app.voiceKeys = store
	key := "isolated-api-key-value-123456"
	response := controllerRecordedRequest(t, app, token, "POST", "/api/voice-key", `{"key":"`+key+`"}`)
	var body struct {
		OK  bool
		Key security.KeyStatus
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.OK || !body.Key.Configured || strings.Contains(response.Body.String(), key) {
		t.Fatal("protected key save failed or reflected its credential")
	}
	response = controllerRecordedRequest(t, app, token, "DELETE", "/api/voice-key", "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Key.Configured {
		t.Fatal("protected key removal did not update public status")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/call", `{"provider":"api"}`), 400, "invalid_request")
	if err := os.Mkdir(filepath.Join(app.options.DataDir, security.VoiceKeyFileName), 0700); err != nil {
		t.Fatal(err)
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "DELETE", "/api/voice-key", ""), 502, "request_failed")
}

func TestControllerProfileSelectionRetiresOldBindingWithoutConnecting(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	directory := t.TempDir()
	key := filepath.Join(directory, "fixture-key")
	if err := os.WriteFile(key, []byte("isolated key"), 0600); err != nil {
		t.Fatal(err)
	}
	binding := computer.Binding{Host: "isolated.invalid", User: "dant", Port: 22, KeyPath: key}
	raw, _ := json.Marshal(binding)
	if err := os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(struct {
		Directory string `json:"directory"`
	}{directory})
	app.profileError = new(string)
	response := controllerRecordedRequest(t, app, token, "POST", "/api/vm/import", string(body))
	var result computer.ProfileImported
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.OK || result.Connected || app.profileError != nil || bridge.Generation() != 1 || bridge.connects != 0 {
		t.Fatal("profile selection failed to retire the old owner or connected implicitly")
	}
	if err := app.backups.Configure(context.Background(), []byte(`{"beforeVmChange":false}`)); err != nil {
		t.Fatal(err)
	}
	response = controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"vm":{"port":2222}}`)
	if response.Code != 200 {
		t.Fatal("partial VM patch did not retain existing key and identity")
	}
	retained, err := computer.ReadBinding(app.options.DataDir)
	if err != nil || retained.Port != 2222 || retained.KeyPath != key || retained.Host != binding.Host {
		t.Fatal("partial VM patch discarded an existing binding field")
	}
}

func TestControllerCurrentObservationsPersistCacheButIgnoreMalformedAndClosedEvents(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.generation = 1
	bridge.state = controllerQuiescentState(contracts.ConnectionStatusOnline)
	bridge.state.ConversationID = "isolated"
	bridge.state.Call = &contracts.Call{ID: "fixture-call", Provider: "subscription", Status: "connected"}
	state := bridge.state
	bridge.mu.Unlock()
	raw, _ := json.Marshal(state)
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: json.RawMessage(`{`)})
	if app.Snapshot().ConversationID != "" {
		t.Fatal("malformed observation replaced cached conversation")
	}
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: raw})
	app.observe(computer.BridgeEvent{Generation: 1, Type: "realtime", Data: json.RawMessage(`{"method":"dant/call/subtitle","params":{"callId":"fixture-call","provider":"subscription","sequence":1,"text":"transient fixture","final":true}}`)})
	if caption := captions.ReadCaption(app.Snapshot().Extra["callCaption"]); caption == nil || caption.Text != "transient fixture" {
		t.Fatal("current realtime caption was not relayed")
	}
	app.observe(computer.BridgeEvent{Generation: 1, Type: "realtime", Data: json.RawMessage(`{`)})
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if cached := readCached(app.options.DataDir); cached.ConversationID == state.ConversationID {
			break
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatal("owned cache loop did not persist a current snapshot")
		}
	}
	disk, err := os.ReadFile(filepath.Join(app.options.DataDir, "state-cache.json"))
	if err != nil || bytes.Contains(disk, []byte("transient fixture")) {
		t.Fatal("transient realtime caption entered durable cache")
	}
	app.Close()
	state.ConversationID = "closed-owner"
	raw, _ = json.Marshal(state)
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: raw})
	if app.Snapshot().ConversationID != "isolated" {
		t.Fatal("closed controller accepted a late observation")
	}
}

func TestControllerAdmissionPreservesUnknownTransportOutcomesAndClosingState(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
		return nil, &computer.RequestError{UnknownOutcome: true}
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/messages", `{}`), 502, "request_failed")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/updates/install-lease", `{}`), 409, "desktop_transition_busy")
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/connect", `{}`), 409, "desktop_transition_busy")
	app.Close()
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "GET", "/api/state", ""), 503, "controller_closed")
}

func TestControllerErrorsClassifyWrappedOperationalFailuresWithoutRawDetails(t *testing.T) {
	for _, fixture := range []struct {
		err    error
		status int
		code   string
	}{
		{backups.ErrBusy, 409, "backup_running"},
		{backups.ErrRestoreUnconfirmed, 409, "backup_restore_unconfirmed"},
		{backups.ErrBeforeVMChange, 409, "backup_before_vm_change_required"},
		{&computer.LifecycleError{Reason: computer.LifecycleReasonInvalidTimeout}, 400, "invalid_request"},
		{errors.New("synthetic private diagnostic"), 502, "request_failed"},
	} {
		response := httptest.NewRecorder()
		writeError(response, fmt.Errorf("synthetic private wrapper: %w", fixture.err))
		assertControllerCode(t, response, fixture.status, fixture.code)
		if strings.Contains(response.Body.String(), "synthetic private") {
			t.Fatal("unclassified diagnostic escaped the public API")
		}
	}
	phase := &desktopPhaseError{phase: contracts.DesktopPhasePausing, cause: context.Canceled}
	if phase.Error() != "desktop_transition_failed" || !errors.Is(phase, context.Canceled) {
		t.Fatal("desktop phase error lost its bounded category or cause")
	}
	if desktopDiagnosticCode("synthetic-unknown-code") != "request_failed" {
		t.Fatal("unknown desktop diagnostic category was reflected")
	}
}

func TestControllerProxyHeadAndFailedStreamsPreserveDownloadSemantics(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	request := httptest.NewRequest("GET", "http://127.0.0.1:4317/api/files/fixture", nil)
	request.URL.RawQuery = "name=%ZZ"
	if err := app.proxy(httptest.NewRecorder(), request); !errors.Is(err, computer.ErrBinding) {
		t.Fatal("malformed attachment query was forwarded")
	}
	bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(controllerFailingReader{})}, nil
	}
	response := controllerRecordedRequest(t, app, token, "HEAD", "/api/files/fixture", "")
	if response.Code != 200 || response.Body.Len() != 0 || response.Header().Get("Content-Type") != "image/png" {
		t.Fatal("attachment HEAD read the body or lost response headers")
	}
	func() {
		defer func() {
			if recover() != http.ErrAbortHandler {
				t.Fatal("failed attachment stream did not abort the partial HTTP response")
			}
		}()
		_ = app.proxy(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/files/fixture", nil))
	}()
	if response := controllerRecordedRequest(t, app, token, "POST", "/events", `{}`); response.Code != 405 {
		t.Fatal("event socket route admitted a mutation method")
	}
}

func TestControllerInstallPreparationRevalidatesLiveWorkerBeforeLeaseGrant(t *testing.T) {
	app, bridge, power, token := controllerOperationsFixture(t)
	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.state = controllerQuiescentState(contracts.ConnectionStatusOnline)
	bridge.mu.Unlock()
	refreshes := 0
	bridge.refreshOperation = func(context.Context) (contracts.WorkerSnapshot, error) {
		refreshes++
		return bridge.Snapshot(), context.DeadlineExceeded
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/updates/install-lease", `{}`), 409, "desktop_transition_busy")
	if app.lease.Current() != nil || app.desktop.Blocked() || power.resumed != 0 || refreshes != 1 {
		t.Fatal("failed live worker revalidation granted a lease or left a local pause")
	}
	bridge.refreshOperation = nil
	response := controllerRecordedRequest(t, app, token, "GET", "/api/state", "")
	if response.Code != 200 {
		t.Fatal("online state refresh was not available after failed installation preparation")
	}
	if response := controllerRecordedRequest(t, app, token, "POST", "/api/prepare", `{}`); response.Code != 200 {
		t.Fatal("failed lease acquisition permanently blocked explicit preparation")
	}
}
