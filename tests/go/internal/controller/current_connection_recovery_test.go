package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestControllerCurrentWorkerReconnectPreservesPausedUnknownHistory(t *testing.T) {
	for _, fixture := range []struct {
		name       string
		wantStatus int
		wantPosts  int
	}{
		{"paused unknown history", 200, 1},
		{"wrong source", 502, 0},
		{"wrong protocol", 502, 0},
		{"wrong version", 502, 0},
		{"wrong role", 502, 0},
		{"binding changed", 502, 0},
		{"generation changed", 502, 0},
		{"cancelled", 499, 0},
		{"queued work", 409, 0},
		{"active work", 409, 0},
		{"unpaused executor", 409, 0},
		{"computer pending", 409, 0},
		{"observed stop fence", 409, 0},
		{"worker stop fence refusal", 502, 1},
		{"pause changed", 409, 1},
		{"conversation changed", 409, 1},
		{"source changed after recovery", 502, 1},
		{"new queued work", 409, 1},
		{"new stop fence", 409, 1},
		{"confirmed idle stop fence", 409, 0},
		{"confirmed idle new stop fence", 409, 1},
		{"confirmed idle pause changed", 409, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			app, bridge, power, token := controllerOperationsFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			bindingPath := filepath.Join(app.options.DataDir, "vm.json")
			if err := os.WriteFile(filepath.Join(app.options.DataDir, "fixture.key"), []byte("isolated key"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(bindingPath, []byte(`{"host":"fixture.invalid","user":"fixture","keyPath":"fixture.key"}`), 0600); err != nil {
				t.Fatal(err)
			}
			bridge.status = contracts.ConnectionStatusOnline
			bridge.state = controllerQuiescentState(contracts.ConnectionStatusOffline)
			bridge.state.ConversationID = "retained-conversation"
			bridge.state.Settings.Language = app.configuration.Language
			bridge.state.Settings.TimeZone = app.options.TimeZone
			bridge.state.Executor.Paused = true
			bridge.state.Messages = []*contracts.ChatMessage{{
				ID: "retained-message", Role: contracts.RoleUser,
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
			}}
			bridge.state.WorkTasks = []contracts.WorkRecord{{
				ID: "retained-work", Status: contracts.WorkStatusUnknown, UnknownOutcome: true,
			}}
			messages, _ := json.Marshal(bridge.state.Messages)
			work, _ := json.Marshal(bridge.state.WorkTasks)
			if strings.HasPrefix(fixture.name, "confirmed idle") {
				bridge.state.Messages = []*contracts.ChatMessage{}
				bridge.state.WorkTasks = []contracts.WorkRecord{}
				messages, _ = json.Marshal(bridge.state.Messages)
				work, _ = json.Marshal(bridge.state.WorkTasks)
			}
			switch fixture.name {
			case "queued work":
				bridge.state.Queue = []string{"retained-queued-message"}
			case "active work":
				bridge.state.Active = &contracts.ActiveExecution{Status: contracts.TaskStatusUnknown}
			case "unpaused executor":
				bridge.state.Executor.Paused = false
			case "computer pending":
				bridge.state.Extra["computer"] = json.RawMessage(`{"status":"dant","sessionId":null,"pending":true,"acquiring":false}`)
			case "observed stop fence", "confirmed idle stop fence":
				bridge.state.Extra["executorStopUnconfirmed"] = json.RawMessage("true")
			}
			posts := 0
			bridge.request = func(_ context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
				status, response := http.StatusOK, `{"ok":true}`
				if method == http.MethodGet && route == "/api/session" {
					session := map[string]any{
						"product": "dant", "mode": "worker", "runtime": "go", "protocol": 1,
						"version": app.options.Version, "source": app.options.BuildSource,
					}
					switch fixture.name {
					case "wrong source":
						session["source"] = strings.Repeat("b", 40)
					case "wrong protocol":
						session["protocol"] = 2
					case "wrong version":
						session["version"] = "0.4.6"
					case "wrong role":
						session["mode"] = "controller"
					case "binding changed":
						if err := os.WriteFile(bindingPath, []byte(`{"host":"changed.invalid","user":"fixture","keyPath":"fixture.key"}`), 0600); err != nil {
							t.Fatal(err)
						}
					case "generation changed":
						bridge.mu.Lock()
						bridge.generation++
						bridge.mu.Unlock()
					case "cancelled":
						cancel()
					case "source changed after recovery":
						if posts > 0 {
							session["source"] = strings.Repeat("b", 40)
						}
					}
					raw, _ := json.Marshal(session)
					response = string(raw)
				} else {
					raw, _ := io.ReadAll(body)
					if method != http.MethodPost || route != "/api/connect" || string(raw) != `{"idleRecovery":true}` || headers.Get("Content-Type") != "application/json" {
						t.Fatal("recovery attempted an update, work retry or unrelated route")
					}
					posts++
					bridge.mu.Lock()
					bridge.state.Worker.Status = contracts.ConnectionStatusOnline
					switch fixture.name {
					case "worker stop fence refusal":
						status, response = http.StatusConflict, `{"code":"executor_stop_unconfirmed"}`
					case "pause changed", "confirmed idle pause changed":
						bridge.state.Executor.Paused = false
					case "conversation changed":
						bridge.state.ConversationID = "replacement-conversation"
					case "new queued work":
						bridge.state.Queue = []string{"new-queued-message"}
					case "new stop fence", "confirmed idle new stop fence":
						bridge.state.Extra["executorStopUnconfirmed"] = json.RawMessage("true")
					}
					bridge.mu.Unlock()
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(response))}, nil
			}
			request := httptest.NewRequestWithContext(ctx, http.MethodPost,
				"http://127.0.0.1:4317"+computerConnectRoute, strings.NewReader(`{}`))
			request.Header.Set("X-Dant-Token", token)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != fixture.wantStatus || posts != fixture.wantPosts || power.resumed != 0 || power.suspended != 0 || app.connectionPending || app.manual {
				t.Fatal("current Worker recovery lost an identity or admission boundary", response.Code, posts)
			}
			retainedMessages, _ := json.Marshal(bridge.state.Messages)
			retainedWork, _ := json.Marshal(bridge.state.WorkTasks)
			if !bytes.Equal(messages, retainedMessages) || !bytes.Equal(work, retainedWork) {
				t.Fatal("reconnect changed or retried durable unknown work")
			}
		})
	}
}
