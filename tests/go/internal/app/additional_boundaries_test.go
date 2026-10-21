package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestWorkerConversationAndWorkRoutesRejectMalformedFieldsBeforeChangingState(t *testing.T) {
	app := fixtureWorker(t)
	for _, item := range []struct {
		method, route, body string
		status              int
	}{
		{"POST", "/api/retry/missing", `{`, 400},
		{"POST", "/api/tasks/resume", `{"ids":[],"confirmUnknown":"true"}`, 400},
		{"POST", "/api/tasks/resume", `{"ids":["missing"]}`, 409},
		{"POST", "/api/tasks/missing/accept", `{}`, 404},
		{"POST", "/api/tasks/missing/cancel", `{"kind":"work","turnId":null,"callId":true}`, 400},
		{"POST", "/api/tasks/missing/cancel", `{"kind":"work","turnId":null,"conversationId":"stale"}`, 409},
		{"POST", "/api/tasks/missing/resume", `{`, 400},
		{"POST", "/api/tasks/missing/resume", `{"kind":"work","turnId":"turn"}`, 409},
		{"POST", "/api/tasks/missing/priority", `{`, 400},
		{"POST", "/api/tasks/missing/dismiss", `{`, 400},
		{"PATCH", "/api/messages/missing", `{"text":"x","resubmit":null}`, 400},
		{"POST", "/api/messages", `{"text":"x","clientMessageId":"\ud800"}`, 400},
		{"POST", "/api/messages", `{"text":true}`, 400},
		{"POST", "/api/messages", `{"text":"x","attachments":[3]}`, 400},
		{"POST", "/api/read", `{"ids":["message"],"attachmentSnapshots":{"message":[3]}}`, 400},
		{"POST", "/api/read", `{"ids":["message"],"conversationId":"stale"}`, 409},
		{"POST", "/api/schedules", `{`, 400},
		{"PATCH", "/api/schedules/missing", `{"id":"another"}`, 400},
		{"DELETE", "/api/schedules/missing", `{}`, 404},
	} {
		response := callWorker(app, item.method, item.route, item.body)
		if response.Code != item.status {
			t.Fatalf("%s %s = %d, want %d; %s", item.method, item.route, response.Code, item.status, response.Body.String())
		}
	}
	if len(app.store.Snapshot().Messages) != 0 || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("rejected request changed conversation admission")
	}
	if err := app.submitCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{}); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("nil accepted call message was dereferenced or submitted", err)
	}
	var classified *contracts.APIError
	if !errors.As(conversationRouteError(workerRuntime.ErrDisconnected), &classified) || classified.Status != 409 {
		t.Fatal("disconnected transport did not retain a classified conflict")
	}
}

func TestWorkerSkillRefreshRejectsMissingBoundariesMalformedDataAndLastMomentScopeChanges(t *testing.T) {
	workspace, skill := discoveryFixture(t)
	if result := (&WorkerApp{}).refreshSkills(t.Context(), work.ToolContext{}, skill); result.Refreshed {
		t.Fatal("unassembled Worker refreshed skills")
	}
	for _, scenario := range []string{"relative", "unclean", "empty-data", "invalid-skills", "invalid-candidate", "late-scope", "null-string"} {
		t.Run(scenario, func(t *testing.T) {
			path := workspace
			if scenario == "relative" {
				path = "relative-workspace"
			}
			if scenario == "unclean" {
				path += string(filepath.Separator) + "."
			}
			checks, requests := 0, 0
			result := refreshSkillDiscovery(t.Context(), skillRefresh{
				workspace: path,
				current:   func() bool { checks++; return scenario != "late-scope" || checks < 3 },
				request: func(context.Context, string, contracts.RawObject) (contracts.RawObject, error) {
					requests++
					if scenario == "empty-data" {
						return contracts.RawObject{}, nil
					}
					row := contracts.RawObject{"cwd": encode(workspace), "skills": encode([]skills.Summary{skill.Summary})}
					switch scenario {
					case "invalid-skills":
						row["skills"] = encode(3)
					case "invalid-candidate":
						row["skills"] = json.RawMessage(`[null]`)
					case "null-string":
						row["cwd"] = encode(nil)
					}
					return contracts.RawObject{"data": encode([]contracts.RawObject{row})}, nil
				},
			}, skill)
			if scenario == "relative" || scenario == "unclean" {
				if requests != 0 || result.Refreshed {
					t.Fatal("invalid workspace crossed the discovery boundary")
				}
			} else if scenario == "late-scope" && result.Refreshed {
				t.Fatal("retired owner claimed a successful refresh")
			}
		})
	}
	app, _, owner := acknowledgedToolFixture(t)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if result := app.refreshSkills(cancelled, owner, skill); result.Refreshed {
		t.Fatal("cancelled owner refreshed skills")
	}
}

func TestWorkerReadOnlyProjectionFailuresRemainBoundedAndNeverStartServices(t *testing.T) {
	app := fixtureWorker(t)
	if err := app.scheduleDB.Close(); err != nil {
		t.Fatal(err)
	}
	response := callWorker(app, "GET", "/api/schedules", "")
	if response.Code < 400 {
		t.Fatal("closed schedule database advertised success")
	}
	if _, err := app.routes(); err != nil {
		t.Fatal("route registration changed dependencies", err)
	}
	if _, err := (&WorkerApp{}).routes(); err == nil {
		t.Fatal("routes accepted missing recovery ownership dependencies")
	}
	response = callWorker(app, "POST", "/api/messages/missing/output-link/resolve", `{`)
	if response.Code != 400 {
		t.Fatal("invalid recovery payload was accepted")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	request = request.WithContext(cancelled)
	request.Header.Set("X-Dant-Token", app.auth.Info().Token)
	writer := httptest.NewRecorder()
	app.Handler().ServeHTTP(writer, request)
	if writer.Code < 400 || strings.Contains(writer.Body.String(), app.options.Startup.DataDir) {
		t.Fatal("failed projection exposed a private path or advertised success")
	}
}

func TestScheduleHTTPFailuresPreserveClassificationAndUnknownErrors(t *testing.T) {
	for _, item := range []struct {
		err    error
		status int
	}{
		{schedules.ErrInvalid, 400}, {schedules.ErrNotFound, 404}, {schedules.ErrConflict, 409}, {schedules.ErrUnavailable, 503},
	} {
		var api *contracts.APIError
		if !errors.As(scheduleRouteError(item.err), &api) || api.Status != item.status {
			t.Fatal("schedule failure lost its HTTP classification")
		}
	}
	unknown := errors.New("unclassified failure")
	if scheduleRouteError(unknown) != unknown || scheduleRouteError(nil) != nil {
		t.Fatal("unknown schedule outcome was coerced to a known retryable result")
	}
}
