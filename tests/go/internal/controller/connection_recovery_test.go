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

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestControllerPendingUpgradeReconnectPreservesUnknownHistoryAndRejectsStaleProof(t *testing.T) {
	for _, fixture := range []struct {
		name       string
		wantStatus int
		wantPosts  int
	}{
		{"paused unknown history", 200, 1},
		{"source changed", 502, 0},
		{"protocol changed", 502, 0},
		{"binding changed", 502, 0},
		{"generation changed", 502, 0},
		{"cancelled", 499, 0},
		{"new unknown installation", 409, 0},
		{"unpaused executor", 409, 0},
		{"queued work", 409, 0},
		{"observed stop fence", 409, 0},
		{"worker stop fence refusal", 502, 1},
		{"pause changed", 409, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			app, bridge, power, token := controllerOperationsFixture(t)
			requestContext, cancel := context.WithCancel(t.Context())
			defer cancel()
			bindingPath := filepath.Join(app.options.DataDir, "vm.json")
			if err := os.WriteFile(filepath.Join(app.options.DataDir, "fixture.key"), []byte("isolated key"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(bindingPath, []byte(`{"host":"fixture.invalid","user":"fixture","keyPath":"fixture.key"}`), 0600); err != nil {
				t.Fatal(err)
			}
			binding, err := computer.ReadBinding(app.options.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			pending := &computer.PendingDeploymentError{
				BindingDigest: computer.BindingDigest(binding),
				Version:       "0.4.7-beta.23",
				Source:        strings.Repeat("b", 40),
			}
			bridge.status = contracts.ConnectionStatusOnline
			bridge.state = controllerQuiescentState(contracts.ConnectionStatusOffline)
			bridge.state.Extra["computer"] = json.RawMessage(`{"status":"dant","sessionId":null,"expiresAt":0}`)
			bridge.state.Settings.Language = app.configuration.Language
			bridge.state.Settings.TimeZone = app.options.TimeZone
			bridge.state.Executor.Paused = fixture.name != "unpaused executor"
			bridge.state.Messages = []*contracts.ChatMessage{{
				ID:             "retained-message",
				Role:           contracts.RoleUser,
				UnknownOutcome: true,
				Status:         contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission:     contracts.Some(contracts.SubmissionStatusUnknown),
			}}
			bridge.state.WorkTasks = []contracts.WorkRecord{{
				ID:             "retained-work",
				Status:         contracts.WorkStatusUnknown,
				UnknownOutcome: true,
			}}
			messages, _ := json.Marshal(bridge.state.Messages)
			work, _ := json.Marshal(bridge.state.WorkTasks)
			if fixture.name == "queued work" {
				bridge.state.Queue = []string{"queued-message"}
			}
			if fixture.name == "observed stop fence" {
				bridge.state.Extra["executorStopUnconfirmed"] = json.RawMessage("true")
			}
			bridge.connectOperation = func(_ context.Context, deploy bool) error {
				if !deploy {
					t.Fatal("an online bridge was unnecessarily replaced")
				}
				if fixture.name == "new unknown installation" {
					return computer.ErrDeploymentUnconfirmed
				}
				return pending
			}
			posts := 0
			bridge.request = func(_ context.Context, method, route string, _ http.Header, body io.Reader) (*http.Response, error) {
				status := 200
				response := `{"ok":true}`
				if method == http.MethodGet && route == "/api/session" {
					session := map[string]any{
						"product": "dant", "mode": "worker", "runtime": "go", "protocol": 1,
						"version": pending.Version, "source": pending.Source,
					}
					switch fixture.name {
					case "source changed":
						session["source"] = strings.Repeat("c", 40)
					case "protocol changed":
						session["protocol"] = 2
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
					}
					raw, _ := json.Marshal(session)
					response = string(raw)
				} else {
					raw, _ := io.ReadAll(body)
					if method != http.MethodPost || route != "/api/connect" || string(raw) != `{"idleRecovery":true}` {
						t.Fatal("recovery attempted an update, resume or unrelated route")
					}
					posts++
					if fixture.name == "worker stop fence refusal" {
						status = 409
						response = `{"code":"executor_stop_unconfirmed"}`
					} else {
						bridge.mu.Lock()
						bridge.state.Worker.Status = contracts.ConnectionStatusOnline
						bridge.mu.Unlock()
					}
					if fixture.name == "pause changed" {
						bridge.mu.Lock()
						bridge.state.Executor.Paused = false
						bridge.mu.Unlock()
					}
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(response))}, nil
			}
			request := httptest.NewRequestWithContext(requestContext, http.MethodPost,
				"http://127.0.0.1:4317"+computerConnectRoute, strings.NewReader(`{}`))
			request.Header.Set("X-Dant-Token", token)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != fixture.wantStatus || posts != fixture.wantPosts ||
				power.resumed != 0 || power.suspended != 0 || app.connectionPending || app.manual {
				t.Fatal("pending recovery lost an admission or identity boundary", response.Code, posts)
			}
			retainedMessages, _ := json.Marshal(bridge.state.Messages)
			retainedWork, _ := json.Marshal(bridge.state.WorkTasks)
			if !bytes.Equal(messages, retainedMessages) || !bytes.Equal(work, retainedWork) {
				t.Fatal("idle recovery changed or retried durable unknown work")
			}
		})
	}
}
