package runtime

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func routingResponse(t *testing.T, text string) contracts.RawObject {
	t.Helper()
	object, err := contracts.DecodeObject([]byte(text), MaxRPCFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	return object
}

func TestConversationRoutingRequiresTheSameDefaultAccountAndBackend(t *testing.T) {
	for _, scenario := range []struct {
		name, account, response string
		valid                   bool
	}{
		{"api-default", "", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`, true},
		{"api-null-extension", "", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}`, true},
		{"chatgpt-legacy", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}`, true},
		{"chatgpt-default", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-account","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}`, true},
		{"missing-auth", "", `{"account":{"type":"apiKey"}}`, false},
		{"no-openai-auth", "", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":false}`, false},
		{"missing-account", "synthetic-account", `{"account":null,"requiresOpenaiAuth":true}`, false},
		{"changed-mode", "synthetic-account", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`, false},
		{"changed-api-mode", "", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}`, false},
		{"bad-routing", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":false}`, false},
		{"api-routing", "", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":{}}`, false},
		{"different-workspace", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"different-account","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}`, false},
		{"different-origin", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-account","backendOrigin":"https://example.invalid","accountRoutingOverride":"NO_CONSTRAINT"}}`, false},
		{"residency", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-account","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"us"}}`, false},
		{"unknown-override", "synthetic-account", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-account","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"future-policy"}}`, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			err := validateConversationRouting(conversationAuth{account: scenario.account}, routingResponse(t, scenario.response))
			if (err == nil) != scenario.valid {
				t.Fatal("conversation account routing eligibility was incorrect", err)
			}
		})
	}
}

func TestConversationRoutingConfigurationNeverSilentlyChangesResidency(t *testing.T) {
	for _, input := range []string{`{}`, `{"chatgpt_base_url":null,"enforce_residency":null}`, `{"chatgpt_base_url":"https://chatgpt.com/backend-api"}`, `{"chatgpt_base_url":"https://chatgpt.com/backend-api/"}`} {
		if err := validateConversationRouteConfig(routingResponse(t, input)); err != nil {
			t.Fatal("the original default route was rejected", err)
		}
	}
	for _, input := range []string{`{"chatgpt_base_url":false}`, `{"chatgpt_base_url":"https://example.invalid/backend-api/"}`, `{"chatgpt_base_url":"http://chatgpt.com/backend-api/"}`, `{"enforce_residency":"us"}`, `{"enforce_residency":false}`} {
		if err := validateConversationRouteConfig(routingResponse(t, input)); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("a nondefault or malformed backend route was accepted", err)
		}
	}
}

func TestConversationAuthPreservesPinnedEffortAndReadsTheOriginalWorkspace(t *testing.T) {
	for _, effort := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"} {
		t.Run(effort, func(t *testing.T) {
			origin := newRPCFixture(t)
			workspace := filepath.Join(t.TempDir(), "synthetic-conversation")
			done := make(chan error, 1)
			go func() {
				auth, err := readConversationAuth(t.Context(), origin.client, nil, workspace)
				if err == nil && auth.effort != effort {
					err = ErrInvalidProtocol
				}
				done <- err
			}()
			request := rpcMethod(t, origin, "config/read")
			var params struct {
				CWD string `json:"cwd"`
			}
			if json.Unmarshal(request["params"], &params) != nil || params.CWD != workspace {
				t.Fatal("provider validation ignored the original workspace configuration")
			}
			configuration, _ := json.Marshal(map[string]any{"config": map[string]string{"model_reasoning_effort": effort}})
			replyFixture(t, origin, request, string(configuration))
			replyFixture(t, origin, rpcMethod(t, origin, "getAuthStatus"), syntheticAuthResult("apikey", "synthetic-token"))
			if err := <-done; err != nil {
				t.Fatal("a pinned supported reasoning effort was rejected", err)
			}
		})
	}
}

func TestConversationSessionRejectsWorkspaceMismatchBeforeSpawning(t *testing.T) {
	f := sessionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := f.worker.OpenConversation(t.Context(), "captured-conversation", func() bool { return true })
		done <- err
	}()
	replyFixture(t, f.origin, rpcMethod(t, f.origin, "config/read"), `{"config":{}}`)
	claims, _ := json.Marshal(map[string]any{"exp": time.Now().Add(time.Hour).Unix(), "https://api.openai.com/auth": map[string]string{"chatgpt_account_id": "synthetic-original-account"}})
	replyFixture(t, f.origin, rpcMethod(t, f.origin, "getAuthStatus"), syntheticAuthResult("chatgpt", syntheticConversationToken(string(claims))))
	replyFixture(t, f.origin, rpcMethod(t, f.origin, "account/read"), `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"different-account","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}`)
	if err := <-done; !errors.Is(err, ErrInvalidProtocol) || f.spawns.Load() != 0 {
		t.Fatal("a changed workspace received an isolated process or bearer", err)
	}
}
