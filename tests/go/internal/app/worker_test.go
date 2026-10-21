package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

func fixtureWorkerOptions(t *testing.T) WorkerOptions {
	t.Helper()
	root := t.TempDir()
	startup, err := config.LoadStartup(config.StartupInput{
		Arguments: []string{"--role=worker"}, Environment: []string{},
		WorkingDirectory: root, Home: root, Hostname: "fixture-vm", Username: "fixture-user",
	})
	if err != nil {
		t.Fatal(err)
	}
	uid := 1000
	offlineHTTP := appHTTPFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("isolated_fixture_http_denied")
	})
	return WorkerOptions{
		Startup: startup, Version: "0.0.0-test.1", Source: strings.Repeat("a", 40),
		VerifyHost: func(context.Context) error { return nil },
		VoiceHTTP:  offlineHTTP, TelegramHTTP: offlineHTTP, UpdateHTTP: offlineHTTP,
		WorkerOptions: workerRuntime.WorkerOptions{
			Platform: "linux", UID: &uid,
			Client:        offlineHTTP,
			VerifyRuntime: func(context.Context) error { return errors.New("isolated_fixture_offline") },
		},
	}
}

func fixtureWorker(t *testing.T) *WorkerApp {
	t.Helper()
	app, err := NewWorker(context.Background(), fixtureWorkerOptions(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app
}

func callWorker(app *WorkerApp, method, route, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://127.0.0.1:4317"+route, strings.NewReader(body))
	request.Header.Set("X-Dant-Token", app.auth.Info().Token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	return response
}

func TestWorkerRoleVerificationPrecedesAuthoritativeWrites(t *testing.T) {
	options := fixtureWorkerOptions(t)
	options.VerifyHost = func(context.Context) error { return workerRuntime.ErrWorkerRole }
	if _, err := NewWorker(context.Background(), options); !errors.Is(err, workerRuntime.ErrWorkerRole) {
		t.Fatal(err)
	}
	if _, err := os.Lstat(options.Startup.DataDir); !os.IsNotExist(err) {
		t.Fatal("rejected host created authoritative data")
	}
	options.Startup.Role = config.RoleController
	if _, err := NewWorker(context.Background(), options); !errors.Is(err, config.ErrStartup) {
		t.Fatal(err)
	}
}

func TestWorkerConstructionOwnsDataWithoutConnectingExternalServices(t *testing.T) {
	app := fixtureWorker(t)
	if app.worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("construction connected executor")
	}
	if app.calls.Snapshot() != nil {
		t.Fatal("construction created a voice session")
	}
	if _, err := ownership.Acquire(context.Background(), app.options.Startup.DataDir); !errors.Is(err, ownership.ErrBusy) {
		t.Fatal(err)
	}
	response := callWorker(app, http.MethodGet, "/api/state", "")
	if response.Code != http.StatusOK {
		t.Fatalf("state status %d: %s", response.Code, response.Body)
	}
	var state contracts.WorkerSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	var capabilities workerCapabilities
	if json.Unmarshal(state.Extra["capabilities"], &capabilities) != nil || len(capabilities.Languages) != 16 {
		t.Fatal("language capabilities lost")
	}
	if state.ConversationID == "" || state.Mode != "vm-worker" {
		t.Fatal("snapshot lost durable identity")
	}
	app.Close()
	lock, err := ownership.Acquire(context.Background(), app.options.Startup.DataDir)
	if err != nil {
		t.Fatal("shutdown retained ownership", err)
	}
	_ = lock.Close()
}

func TestWorkerHTTPAuthenticationAndReadOnlyDiagnostics(t *testing.T) {
	app := fixtureWorker(t)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/api/state", nil)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatal(response.Code)
	}
	if response = callWorker(app, http.MethodPost, "/api/diagnostics", `{}`); response.Code != http.StatusMethodNotAllowed {
		t.Fatal(response.Code)
	}
	if response = callWorker(app, http.MethodPost, "/api/internal/credentials", `{"tool":"credential_find","arguments":{}}`); response.Code != http.StatusForbidden {
		t.Fatal(response.Code)
	}
	if response = callWorker(app, http.MethodGet, "/api/version", ""); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), app.options.Version) {
		t.Fatal(response.Code)
	}
}

func TestWorkerPreferenceValidationIsAtomicAndPersistent(t *testing.T) {
	app := fixtureWorker(t)
	before := app.store.Snapshot().Settings
	response := callWorker(app, http.MethodPatch, "/api/settings", `{"language":"ja","showCallCaptions":"false"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatal(response.Code)
	}
	if app.store.Snapshot().Settings.Language != before.Language {
		t.Fatal("partial preference mutation")
	}
	response = callWorker(app, http.MethodPatch, "/api/settings", `{"language":"ja","showCallCaptions":true,"model":"fixture-model","nativeVoice":"ember","apiVoice":"marin","timeZone":"Asia/Kuala_Lumpur"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("%d: %s", response.Code, response.Body)
	}
	saved, err := os.ReadFile(filepath.Join(app.options.Startup.DataDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state contracts.State
	if json.Unmarshal(saved, &state) != nil || state.Settings.Language != "ja" || !state.Settings.ShowCallCaptions {
		t.Fatal("preference save missing")
	}
}

func TestEventHubCoalescesStateAndBoundsControlEvents(t *testing.T) {
	hub := newEventHub()
	client, ok := hub.subscribe(context.Background())
	if !ok {
		t.Fatal("subscription failed")
	}
	defer hub.close()
	for index := 0; index < 100; index++ {
		hub.publish("state", index)
	}
	if len(client.states) != 1 {
		t.Fatal("state queue is not bounded")
	}
	if !bytes.Contains(<-client.states, []byte(`"data":99`)) {
		t.Fatal("latest state lost")
	}
	for index := 0; index <= eventControlQueue; index++ {
		hub.publish("notice", index)
	}
	select {
	case <-client.ctx.Done():
	default:
		t.Fatal("unbounded control subscriber retained")
	}
}

func TestMemoryCommitSurvivesFailedLegacyProjection(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var failProjection atomic.Bool
	options.StoreOptions.Write = func(ctx context.Context, name string, data []byte, mode fs.FileMode) error {
		if failProjection.Load() {
			return errors.New("isolated_state_write_failure")
		}
		return files.WriteAtomic(ctx, name, data, mode)
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)

	failProjection.Store(true)
	response := callWorker(app, http.MethodPatch, "/api/memory/working-memory.md", `{"text":"A confirmed fixture preference."}`)
	if response.Code != http.StatusOK {
		t.Fatalf("committed SQLite note reported unsaved: %d %s", response.Code, response.Body)
	}
	note, err := app.memory.ReadNote(t.Context(), "working-memory.md")
	if err != nil || note != "A confirmed fixture preference." {
		t.Fatal("authoritative note was lost", err)
	}
	response = callWorker(app, http.MethodGet, "/api/state", "")
	var snapshot contracts.WorkerSnapshot
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &snapshot) != nil {
		t.Fatal("snapshot unavailable after projection failure")
	}
	var publicMemory string
	if json.Unmarshal(snapshot.Extra["memory"], &publicMemory) != nil || publicMemory != note {
		t.Fatal("snapshot exposed stale legacy memory")
	}
}
