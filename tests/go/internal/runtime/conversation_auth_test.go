package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func syntheticConversationToken(claims string) string {
	return "synthetic." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".unsigned-fixture"
}

func syntheticAuthResult(method, token string) string {
	value, _ := json.Marshal(map[string]any{"requiresOpenaiAuth": true, "authMethod": method, "authToken": token})
	return string(value)
}

func answerConversationAuth(t *testing.T, origin *rpcFixture, token string) {
	t.Helper()
	replyFixture(t, origin, rpcMethod(t, origin, "config/read"), `{"config":{"model_provider":"openai"}}`)
	request := rpcMethod(t, origin, "getAuthStatus")
	if !strings.Contains(string(request["params"]), `"includeToken":true`) || !strings.Contains(string(request["params"]), `"refreshToken":false`) {
		t.Fatal("conversation authentication did not request the current executor's explicit bearer")
	}
	replyFixture(t, origin, request, syntheticAuthResult("apikey", token))
	replyFixture(t, origin, rpcMethod(t, origin, "account/read"), `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}`)
}

func TestConversationAuthUsesOnlyOriginalRPCAndNeverPutsCredentialsInArguments(t *testing.T) {
	for _, method := range []string{"apikey", "chatgpt", "chatgptAuthTokens"} {
		t.Run(method, func(t *testing.T) {
			origin := newRPCFixture(t)
			token := "synthetic-conversation-secret"
			if method != "apikey" {
				claims, _ := json.Marshal(map[string]any{"exp": time.Now().Add(time.Hour).Unix(), "https://api.openai.com/auth": map[string]string{"chatgpt_account_id": "synthetic-account"}})
				token = syntheticConversationToken(string(claims))
			}
			type result struct {
				auth conversationAuth
				err  error
			}
			done := make(chan result, 1)
			go func() {
				auth, err := readConversationAuth(t.Context(), origin.client, nil, "")
				done <- result{auth, err}
			}()
			replyFixture(t, origin, rpcMethod(t, origin, "config/read"), `{"config":{"model_provider":"openai","model_providers":{},"model":"synthetic-model","model_reasoning_effort":"high"}}`)
			replyFixture(t, origin, rpcMethod(t, origin, "getAuthStatus"), syntheticAuthResult(method, token))
			value := <-done
			if value.err != nil || value.auth.token != token || strings.Contains(strings.Join(value.auth.arguments(), " "), token) || strings.Contains(strings.Join(value.auth.arguments(), " "), "synthetic-account") {
				t.Fatal("conversation transport lost the same-account credential or put it in argv", value.err)
			}
			joined := strings.Join(value.auth.arguments(), " ")
			if !strings.Contains(joined, `model="synthetic-model"`) || !strings.Contains(joined, `model_reasoning_effort="high"`) {
				t.Fatal("private conversation lost the original model fallback")
			}
			if !strings.Contains(joined, `.http_headers={"version"="0.163.0"}`) {
				t.Fatal("private provider lost its pinned builtin version header")
			}
			if !strings.Contains(joined, "request_max_retries=0") || !strings.Contains(joined, "features.shell_tool=false") || !strings.Contains(joined, "features.plugins=false") {
				t.Fatal("conversation authentication enabled retries or execution tools")
			}
			for _, denied := range []string{"browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use", "image_generation", "code_mode_host", "multi_agent_v2", "request_permissions_tool", "skill_mcp_dependency_install", "deferred_executor", "send_message_to_user_async", "tool_suggest"} {
				if !strings.Contains(joined, "features."+denied+"=false") {
					t.Fatal("conversation advertised an action capability", denied)
				}
			}
			if !strings.Contains(joined, "tools.update_plan.enabled=false") {
				t.Fatal("conversation enabled the native task plan tool")
			}
			if method != "apikey" && (value.auth.endpoint != "https://chatgpt.com/backend-api/codex" || value.auth.account != "synthetic-account" || !strings.Contains(joined, "ChatGPT-Account-Id")) {
				t.Fatal("ChatGPT conversation did not retain its original account binding")
			}
		})
	}
}

func TestConversationAuthRejectsCustomProviderAndInvalidAuthWithoutReadingDisk(t *testing.T) {
	for _, configuration := range []string{`{}`, `{"config":null}`, `{"config":{"model_provider":false}}`, `{"config":{"model_provider":"custom"}}`, `{"config":{"model_providers":false}}`, `{"config":{"model_providers":{"unused":{}}}}`, `{"config":{"model":false}}`, `{"config":{"model":""}}`, `{"config":{"model":"bad\nmodel"}}`, `{"config":{"model":"\ud800"}}`, `{"config":{"model_reasoning_effort":"unsupported"}}`, `{"config":{"model_reasoning_effort":false}}`, `{"config":{"model":"` + strings.Repeat("x", conversationModelUnits+1) + `"}}`} {
		origin := newRPCFixture(t)
		done := make(chan error, 1)
		go func() { _, err := readConversationAuth(t.Context(), origin.client, nil, ""); done <- err }()
		replyFixture(t, origin, rpcMethod(t, origin, "config/read"), configuration)
		if err := <-done; !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("custom or malformed provider was accepted", err)
		}
	}
	for _, response := range []string{`{}`, `{"requiresOpenaiAuth":false}`, syntheticAuthResult("unknown", "synthetic-token"), syntheticAuthResult("apikey", ""), syntheticAuthResult("apikey", "a\nb"), syntheticAuthResult("apikey", strings.Repeat("x", conversationCredentialBytes+1)), syntheticAuthResult("chatgpt", "not-a-jwt")} {
		origin := newRPCFixture(t)
		done := make(chan error, 1)
		go func() { _, err := readConversationAuth(t.Context(), origin.client, nil, ""); done <- err }()
		replyFixture(t, origin, rpcMethod(t, origin, "config/read"), `{"config":{}}`)
		replyFixture(t, origin, rpcMethod(t, origin, "getAuthStatus"), response)
		if err := <-done; !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid conversation credential was accepted", err)
		}
	}
}

func TestConversationAccountRejectsInvalidExpiredOrUnboundClaims(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	for _, token := range []string{"no.parts", "a.!.b", syntheticConversationToken(`false`), syntheticConversationToken(`{"exp":1}`), syntheticConversationToken(`{"exp":2000000000,"https://api.openai.com/auth":{"chatgpt_account_id":"bad\u0000account"}}`)} {
		if _, err := conversationAccount(token, now); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid JWT account binding was accepted", err)
		}
	}
	var allowed atomic.Bool
	allowed.Store(true)
	origin := newRPCFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := readConversationAuth(context.Background(), origin.client, func() error {
			if !allowed.Load() {
				return ErrConnectionChanged
			}
			return nil
		}, "")
		done <- err
	}()
	request := rpcMethod(t, origin, "config/read")
	allowed.Store(false)
	replyFixture(t, origin, request, `{"config":{}}`)
	if err := <-done; !errors.Is(err, ErrConnectionChanged) {
		t.Fatal("retired auth scope requested a token", err)
	}
}
