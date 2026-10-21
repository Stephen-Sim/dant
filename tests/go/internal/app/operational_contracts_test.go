package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type appHTTPFunc func(*http.Request) (*http.Response, error)

func (request appHTTPFunc) Do(value *http.Request) (*http.Response, error) { return request(value) }

func requireWorkerStatus(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status {
		body := response.Body.String()
		if len(body) > 1024 {
			body = body[:1024] + " [bounded fixture output]"
		}
		t.Fatalf("unexpected API status: got %d want %d: %s", response.Code, status, body)
	}
}

func TestWorkerOperationalUpdatesAreAuthenticatedBoundedAndReadOnly(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var requests atomic.Int32
	options.UpdateHTTP = appHTTPFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		if request.URL.Scheme != "https" || request.URL.Host != "api.github.com" {
			t.Error("unexpected release metadata authority")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v0.0.0-test.2","html_url":"https://github.com/Stephen-Sim/dant/releases/tag/v0.0.0-test.2","draft":false,"prerelease":false,"assets":[]}`))}, nil
	})
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	before := app.store.Revision()
	for _, route := range []string{"/api/version", "/api/updates"} {
		response := callWorker(app, http.MethodPost, route, `{}`)
		requireWorkerStatus(t, response, 405)
		if response.Header().Get("Allow") != "GET" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("read-only update contract lost")
		}
	}
	for _, query := range []string{"?channel=invalid", "?channel=stable&channel=beta"} {
		requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/updates"+query, ""), 400)
	}
	if requests.Load() != 0 {
		t.Fatal("invalid metadata request reached transport")
	}
	// The release is intentionally incomplete; the public error is classified
	// without exposing arbitrary transport data or modifying executor authority.
	response := callWorker(app, http.MethodGet, "/api/updates", "")
	requireWorkerStatus(t, response, 502)
	if !strings.Contains(response.Body.String(), "UPDATE_INVALID_RELEASE") {
		t.Fatal("invalid release did not retain a bounded classification")
	}
	if requests.Load() != 1 || app.store.Revision() != before {
		t.Fatal("metadata lookup replayed or changed durable conversation")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/diagnostics", ""), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/backups/info", ""), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/provision", `{}`), 409)
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/unavailable", ""), 404)
}

func TestWorkerSettingsValidateAtomicallyAndPreserveExplicitFalseAndVoicePrecedence(t *testing.T) {
	app := fixtureWorker(t)
	for _, body := range []string{
		`{`, `{"vm":{}}`, `{"language":"unknown"}`, `{"language":null}`,
		`{"timeZone":"Not/A_Zone"}`, `{"timeZone":false}`, `{"voice":"Bad Voice"}`,
		`{"nativeVoice":null}`, `{"apiVoice":"unlisted"}`, `{"model":7}`,
		`{"model":"` + strings.Repeat("x", modelNameUnits) + `"}`,
		`{"notifications":null}`, `{"notifications":false,"showWorkSummary":"false"}`,
	} {
		before := app.store.Snapshot().Settings
		requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/settings", body), 400)
		if !reflect.DeepEqual(before, app.store.Snapshot().Settings) {
			t.Fatal("invalid settings partially committed")
		}
	}
	response := callWorker(app, http.MethodPatch, "/api/settings", `{"notifications":false,"showWorkSummary":false,"showCallCaptions":false,"voice":"alloy","nativeVoice":"ember"}`)
	requireWorkerStatus(t, response, 200)
	settings := app.store.Snapshot().Settings
	if settings.Notifications || settings.ShowWorkSummary || settings.ShowCallCaptions || settings.NativeVoice != "ember" || settings.Voice != "ember" {
		t.Fatal("explicit false or explicit native voice was lost")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/settings", `{"voice":"alloy"}`), 200)
	if app.store.Snapshot().Settings.NativeVoice != "alloy" || app.calls.Snapshot() != nil || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("display preferences created work or reconfigured media")
	}
}

func TestWorkerScheduleCRUDUsesPersistentIDsAndRejectsPathBodyConflicts(t *testing.T) {
	app := fixtureWorker(t)
	body := `{"text":"deliberately scheduled fixture","at":"` + time.Now().Add(24*time.Hour).UTC().Format(time.RFC3339) + `","timeZone":"UTC"}`
	response := callWorker(app, http.MethodPost, "/api/schedules", body)
	requireWorkerStatus(t, response, 200)
	var saved struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.ID == "" {
		t.Fatal("created schedule lost identity")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/schedules", ""), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/schedules/"+saved.ID, `{"id":"different","text":"changed"}`), 400)
	requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/schedules/"+saved.ID, `{"text":"updated fixture","enabled":false}`), 200)
	response = callWorker(app, http.MethodGet, "/api/schedules", "")
	if !strings.Contains(response.Body.String(), "updated fixture") || strings.Contains(response.Body.String(), "deliberately scheduled fixture") {
		t.Fatal("schedule update did not persist")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodDelete, "/api/schedules/"+saved.ID, ""), 200)
	response = callWorker(app, http.MethodGet, "/api/schedules", "")
	if strings.Contains(response.Body.String(), saved.ID) || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("management route dispatched or retained deleted schedule")
	}
	for _, route := range []string{"/api/schedules", "/api/schedules/" + saved.ID} {
		method := http.MethodPost
		if strings.HasSuffix(route, saved.ID) {
			method = http.MethodPatch
		}
		requireWorkerStatus(t, callWorker(app, method, route, `{`), 400)
	}
}

func TestWorkerStaticDeliveryIsAnchoredAndNeverFallsBackToHostFiles(t *testing.T) {
	app := fixtureWorker(t)
	dist := filepath.Join(app.options.Startup.Root, "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"index.html": "<main>isolated fixture</main>", "assets/app.js": "export const safeFixture = true;"} {
		if err := os.WriteFile(filepath.Join(dist, filepath.FromSlash(name)), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, route := range []string{"/", "/assets/app.js"} {
		response := callWorker(app, http.MethodGet, route, "")
		requireWorkerStatus(t, response, 200)
		if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Cache-Control") != "no-cache" {
			t.Fatal("static delivery headers lost")
		}
	}
	response := callWorker(app, http.MethodHead, "/assets/app.js", "")
	requireWorkerStatus(t, response, 200)
	if response.Body.Len() != 0 {
		t.Fatal("HEAD exposed a body")
	}
	for _, route := range []string{"/missing", "/assets\\app.js"} {
		requireWorkerStatus(t, callWorker(app, http.MethodGet, route, ""), 404)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/", `{}`), 404)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	request.URL.Path = "assets/../outside"
	response = httptest.NewRecorder()
	app.serveStatic(response, request)
	requireWorkerStatus(t, response, 404)
	if err := os.RemoveAll(dist); err != nil {
		t.Fatal(err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/", ""), 404)
}

func TestWorkerConnectionManagementFailureNeverStartsTaskOrReplaysUnknownStop(t *testing.T) {
	app := fixtureWorker(t)
	for _, test := range []struct {
		route, body string
		status      int
	}{
		{"/api/connect", `{`, 400},
		{"/api/connect", `{"idleRecovery":"yes"}`, 400},
		{"/api/connect", `{}`, 500},
		{"/api/login", `{}`, 409},
		{"/api/logout", `{}`, 409},
	} {
		response := callWorker(app, http.MethodPost, test.route, test.body)
		if test.route == "/api/connect" && test.body == `{}` {
			if response.Code < 400 {
				t.Fatal("unavailable isolated runtime was reported connected")
			}
		} else {
			requireWorkerStatus(t, response, test.status)
		}
	}
	if err := app.engine.FenceUnconfirmedStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/api/connect", "/api/login", "/api/logout"} {
		response := callWorker(app, http.MethodPost, route, `{}`)
		requireWorkerStatus(t, response, 409)
		if !strings.Contains(response.Body.String(), "executor_stop_unconfirmed") {
			t.Fatal("uncertain stop lost its explicit reconciliation fence")
		}
	}
	if len(app.engine.Snapshot().Queue) != 0 || app.calls.Snapshot() != nil {
		t.Fatal("connection failure created work")
	}
}

func TestWorkerRequestShutdownCancelsReadsAndRejectsNewAdmission(t *testing.T) {
	app := fixtureWorker(t)
	entered := make(chan struct{})
	finished := make(chan struct{})
	guarded := app.guardRequests(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		if !errors.Is(request.Context().Err(), context.Canceled) {
			t.Error("shutdown did not propagate cancellation")
		}
	}))
	go func() {
		defer close(finished)
		guarded.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/fixture", nil))
	}()
	<-entered
	app.Close()
	<-finished
	response := httptest.NewRecorder()
	guarded.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/fixture", nil))
	requireWorkerStatus(t, response, 503)
	app.Start()
	app.Close()
}
