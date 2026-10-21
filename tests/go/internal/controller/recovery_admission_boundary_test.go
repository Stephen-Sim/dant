package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestControllerSparseAndMalformedCachePreservesLocalRecoveryAuthority(t *testing.T) {
	for _, malformed := range []bool{false, true} {
		t.Run(map[bool]string{false: "sparse", true: "malformed"}[malformed], func(t *testing.T) {
			app, bridge, _, _ := controllerAppFixture(t)
			state := emptyWorkerSnapshot()
			state.Settings.Extra = nil
			state.Worker.Realtime = nil
			state.Extra = nil
			if malformed {
				state.Extra = contracts.RawObject{"invalid": json.RawMessage(`{`)}
			}
			message := "The VM connection needs to be selected or repaired."
			app.mu.Lock()
			app.configuration.Language = "en"
			app.configuration.ShowCallCaptions = false
			app.cached = state
			app.profileError = &message
			app.mu.Unlock()

			result := app.Snapshot()
			if result.Mode != "vm-controller" || result.Settings.Language != "en" || result.Settings.ShowCallCaptions || result.Worker.Status != contracts.ConnectionStatusOffline {
				t.Fatal("cached state displaced Controller preferences or VM authority")
			}
			if !result.Worker.Error.Present || result.Worker.Error.Value != message || result.Settings.VM.User != "dant" || result.Settings.VM.Port != config.DefaultSSHPort {
				t.Fatal("cache recovery omitted repair guidance or default binding")
			}
			if len(result.Settings.Extra) == 0 || result.Worker.Realtime["key"] == nil || result.Worker.Realtime["api"] == nil || result.Extra["controller"] == nil || result.Extra["invalid"] != nil {
				t.Fatal("sparse cache projections were not safely rebuilt")
			}
			if _, err := json.Marshal(result); err != nil {
				t.Fatal("cache fallback published malformed JSON", err)
			}
			if bridge.connects != 0 || bridge.pauses != 0 {
				t.Fatal("reading recovery state started a Worker operation")
			}
		})
	}
}

func TestControllerEventUpgradeRejectsUntrustedOriginBeforeSubscription(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	for _, fixture := range []struct {
		name, query, origin string
	}{
		{"missing token", "", ""},
		{"wrong token", "untrusted-token", ""},
		{"foreign origin", token, "https://untrusted.invalid"},
		{"lookalike origin", token, "http://127.0.0.1.untrusted.invalid:4317"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/events?token="+fixture.query, nil)
			request.Header.Set("Origin", fixture.origin)
			response := httptest.NewRecorder()
			app.serveWebSocket(response, request)
			if response.Code != http.StatusForbidden || len(app.events.clients) != 0 {
				t.Fatal("untrusted event client acquired a subscription")
			}
		})
	}
}

func TestControllerLeaseAndAppearanceFailuresDoNotForwardMutations(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	forwarded := 0
	bridge.request = func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error) {
		forwarded++
		return nil, computer.ErrBridgeOffline
	}
	for _, fixture := range []struct {
		method, route, body string
		status              int
		code                string
	}{
		{http.MethodPost, "/api/updates/install-lease", `{`, 400, "invalid_request"},
		{http.MethodDelete, "/api/updates/install-lease/not-current", "", 409, "desktop_transition_busy"},
		{http.MethodPatch, "/api/settings", `{"fontSize":1}`, 400, "invalid_request"},
		{http.MethodPatch, "/api/settings", `{"theme":"unsupported"}`, 400, "invalid_request"},
	} {
		response := controllerRecordedRequest(t, app, token, fixture.method, fixture.route, fixture.body)
		assertControllerCode(t, response, fixture.status, fixture.code)
	}
	if forwarded != 0 || app.desktop.Blocked() || app.lease.Current() != nil {
		t.Fatal("rejected local request forwarded work or retained admission")
	}
	if _, err := os.Stat(filepath.Join(app.options.DataDir, "controller.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid appearance partially persisted Controller settings")
	}
	for _, size := range []int{12, 18} {
		body, err := json.Marshal(struct {
			FontSize int    `json:"fontSize"`
			Theme    string `json:"theme"`
		}{size, "dark"})
		if err != nil {
			t.Fatal(err)
		}
		response := controllerRecordedRequest(t, app, token, http.MethodPatch, "/api/settings", string(body))
		if response.Code != http.StatusOK || readConfiguration(app.options.DataDir).FontSize != size || forwarded != 0 {
			t.Fatal("valid appearance boundary was rejected or forwarded as Worker work")
		}
	}
}

func TestControllerConnectionFailuresReleaseExactLocalAdmission(t *testing.T) {
	for _, stage := range []string{"resume", "cancel", "connect", "idle-recovery"} {
		t.Run(stage, func(t *testing.T) {
			app, bridge, basePower, _ := controllerOperationsFixture(t)
			power := &controllerDesktopPower{desktopPowerFixture: basePower}
			app.lifecycle = power
			app.desktop.options.Lifecycle = power
			bridge.state = controllerQuiescentState(contracts.ConnectionStatusOffline)
			calls := 0
			want := context.DeadlineExceeded
			switch stage {
			case "resume":
				power.resume = func(context.Context) (computer.ResumeResult, error) {
					calls++
					return computer.ResumeResult{}, want
				}
			case "cancel":
				app.desktop.Close()
				want = ErrDesktopBusy
			case "connect":
				bridge.status = contracts.ConnectionStatusOnline
				bridge.connectOperation = func(context.Context, bool) error {
					calls++
					return want
				}
			case "idle-recovery":
				bridge.request = func(_ context.Context, method, route string, _ http.Header, body io.Reader) (*http.Response, error) {
					calls++
					raw, err := io.ReadAll(body)
					if err != nil || method != http.MethodPost || route != "/api/connect" || strings.TrimSpace(string(raw)) != `{"idleRecovery":true}` {
						t.Error("idle recovery lost its explicit protocol")
					}
					return nil, want
				}
			}

			err := app.connect(t.Context(), true, false)
			if !errors.Is(err, want) || app.connectionPending || app.lease.Current() != nil {
				t.Fatal("failed connection lost classification or local admission", err)
			}
			if stage == "cancel" {
				if bridge.connects != 0 {
					t.Fatal("retired desktop coordinator still connected")
				}
			} else if calls != 1 {
				t.Fatal("failed operation was replayed or not reached", calls)
			}
			if stage != "idle-recovery" && bridge.connects != 0 {
				t.Fatal("failed preconnection crossed the next connection boundary")
			}
		})
	}
}

func TestControllerResumeFailurePreventsPreparationAndCancelFollowup(t *testing.T) {
	for _, stage := range []string{"prepare", "cancel"} {
		t.Run(stage, func(t *testing.T) {
			app, bridge, basePower, _ := controllerOperationsFixture(t)
			resumes := 0
			app.lifecycle = &controllerDesktopPower{
				desktopPowerFixture: basePower,
				resume: func(context.Context) (computer.ResumeResult, error) {
					resumes++
					return computer.ResumeResult{}, context.DeadlineExceeded
				},
			}
			var err error
			if stage == "prepare" {
				err = app.prepareInstallation(t.Context())
			} else {
				_, err = app.cancelDesktopTransition(t.Context())
			}
			if !errors.Is(err, context.DeadlineExceeded) || resumes != 1 || bridge.connects != 0 || bridge.pauses != 0 || app.desktop.Blocked() {
				t.Fatal("unconfirmed resume advanced desktop state or replayed", err)
			}
		})
	}
}

func TestControllerDefaultFontsAreAvailableOnUnsupportedHostWithoutProcess(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	response := controllerRecordedRequest(t, app, token, http.MethodGet, "/api/fonts", "")
	var result struct {
		Fonts  []string `json:"fonts"`
		Source string   `json:"source"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Fonts == nil || len(result.Fonts) != 0 || result.Source != "fallback" {
		t.Fatal("unsupported host lost bounded local font fallback")
	}
	if bridge.connects != 0 {
		t.Fatal("local font inventory started a Worker connection")
	}
}
