package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	conversationCredentialBytes = 64 * 1024
	conversationProviderID      = "dant_conversation"
	conversationTokenEnv        = "DANT_CONVERSATION_ACCESS_TOKEN"
	conversationAccountEnv      = "DANT_CONVERSATION_ACCOUNT"
	conversationAPIEndpoint     = "https://api.openai.com/v1"
	conversationChatGPTEndpoint = "https://chatgpt.com/backend-api/codex"
	conversationModelUnits      = 256
	conversationCodexVersion    = "0.163.0"
)

// Only the existing executor may supply this short-lived transport credential.
// It is never returned through Worker state, persisted, or used to change the
// signed-in account. Unsupported host-owned authentication remains unsupported.
type conversationAuth struct {
	token, account, endpoint, model, effort string
}

// A nullable config.model leaves selection to the original executor's catalog.
// This is a captured default, not a fallback after a rejected model request.
func conversationCatalogDefault(data json.RawMessage) (string, error) {
	if len(data) == 0 || string(data) == "null" {
		return "", nil
	}
	var models []contracts.RawObject
	if !contracts.ValidUnicodeJSON(data) || json.Unmarshal(data, &models) != nil {
		return "", ErrInvalidProtocol
	}
	selected := ""
	for _, model := range models {
		if model == nil {
			return "", ErrInvalidProtocol
		}
		flag, present := model["isDefault"]
		if !present {
			continue
		}
		var isDefault bool
		if string(flag) == "null" || json.Unmarshal(flag, &isDefault) != nil {
			return "", ErrInvalidProtocol
		}
		if !isDefault {
			continue
		}
		name := observerString(model, "model")
		if selected != "" || strings.TrimSpace(name) == "" || !observerIdentity(name) || contracts.UTF16Length(name) > conversationModelUnits {
			return "", ErrInvalidProtocol
		}
		selected = name
	}
	return selected, nil
}

func readConversationAuth(ctx context.Context, rpc *RPC, guard func() error, workspace string) (conversationAuth, error) {
	params := contracts.RawObject{}
	if workspace != "" {
		params["cwd"], _ = json.Marshal(workspace)
	}
	configuration, err := rpc.RequestGuarded(ctx, "config/read", params, guard)
	if err != nil {
		return conversationAuth{}, err
	}
	config, err := contracts.DecodeObject(configuration["config"], MaxRPCFrameBytes)
	if err != nil {
		return conversationAuth{}, ErrInvalidProtocol
	}
	if err := validateConversationRouteConfig(config); err != nil {
		return conversationAuth{}, err
	}
	provider := ""
	if raw := config["model_provider"]; len(raw) != 0 && string(raw) != "null" && json.Unmarshal(raw, &provider) != nil {
		return conversationAuth{}, ErrInvalidProtocol
	}
	if provider != "" && provider != "openai" {
		return conversationAuth{}, ErrInvalidProtocol
	}
	if raw := config["model_providers"]; len(raw) != 0 && string(raw) != "null" {
		providers, decodeErr := contracts.DecodeObject(raw, MaxRPCFrameBytes)
		if decodeErr != nil || len(providers) != 0 {
			return conversationAuth{}, ErrInvalidProtocol
		}
	}
	model, effort := "", ""
	if raw := config["model"]; len(raw) != 0 && string(raw) != "null" {
		if !contracts.ValidUnicodeJSON(raw) || json.Unmarshal(raw, &model) != nil || strings.TrimSpace(model) == "" || !observerIdentity(model) || contracts.UTF16Length(model) > conversationModelUnits {
			return conversationAuth{}, ErrInvalidProtocol
		}
	}
	if raw := config["model_reasoning_effort"]; len(raw) != 0 && string(raw) != "null" {
		if json.Unmarshal(raw, &effort) != nil {
			return conversationAuth{}, ErrInvalidProtocol
		}
		switch effort {
		case "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent":
		default:
			return conversationAuth{}, ErrInvalidProtocol
		}
	}
	result, err := rpc.RequestGuarded(ctx, "getAuthStatus", contracts.RawObject{
		"includeToken": json.RawMessage("true"), "refreshToken": json.RawMessage("false"),
	}, guard)
	if err != nil {
		return conversationAuth{}, err
	}
	defer delete(result, "authToken")
	var required bool
	if json.Unmarshal(result["requiresOpenaiAuth"], &required) != nil || !required {
		return conversationAuth{}, ErrInvalidProtocol
	}
	token := observerString(result, "authToken")
	if token == "" || len(token) > conversationCredentialBytes || strings.ContainsFunc(token, func(character rune) bool { return character <= 0x20 || character == 0x7f }) {
		return conversationAuth{}, ErrInvalidProtocol
	}
	switch observerString(result, "authMethod") {
	case "apikey":
		return conversationAuth{token: token, endpoint: conversationAPIEndpoint, model: model, effort: effort}, nil
	case "chatgpt", "chatgptAuthTokens":
		account, err := conversationAccount(token, time.Now())
		if err != nil {
			return conversationAuth{}, err
		}
		return conversationAuth{token: token, account: account, endpoint: conversationChatGPTEndpoint, model: model, effort: effort}, nil
	default:
		return conversationAuth{}, ErrInvalidProtocol
	}
}

// This parses only the account binding from a token obtained through the
// authenticated local owner. The provider, rather than this parser, verifies
// its signature. No JWT, claim, or account identifier enters diagnostics.
func conversationAccount(token string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrInvalidProtocol
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(raw) > conversationCredentialBytes || !contracts.ValidUnicodeJSON(raw) {
		return "", ErrInvalidProtocol
	}
	var claims struct {
		Expires int64 `json:"exp"`
		Auth    struct {
			Account string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Expires <= now.Unix() || !observerIdentity(claims.Auth.Account) {
		return "", ErrInvalidProtocol
	}
	return claims.Auth.Account, nil
}

func (auth conversationAuth) arguments() []string {
	encode := func(value string) string {
		raw, _ := json.Marshal(value)
		return string(raw)
	}
	args := []string{
		"-c", "model_provider=" + encode(conversationProviderID),
		"-c", "model_providers." + conversationProviderID + `.name="dant conversation"`,
		"-c", "model_providers." + conversationProviderID + ".base_url=" + encode(auth.endpoint),
		"-c", "model_providers." + conversationProviderID + ".env_key=" + encode(conversationTokenEnv),
		"-c", "model_providers." + conversationProviderID + `.wire_api="responses"`,
		"-c", "model_providers." + conversationProviderID + ".requires_openai_auth=false",
		"-c", "model_providers." + conversationProviderID + ".supports_websockets=false",
		"-c", "model_providers." + conversationProviderID + `.http_headers={"version"=` + encode(conversationCodexVersion) + "}",
		"-c", "model_providers." + conversationProviderID + ".request_max_retries=0",
		"-c", "model_providers." + conversationProviderID + ".stream_max_retries=0",
	}
	if auth.account != "" {
		args = append(args, "-c", "model_providers."+conversationProviderID+`.env_http_headers={"ChatGPT-Account-Id"=`+encode(conversationAccountEnv)+"}")
	}
	if auth.model != "" {
		args = append(args, "-c", "model="+encode(auth.model))
	}
	if auth.effort != "" {
		args = append(args, "-c", "model_reasoning_effort="+encode(auth.effort))
	}
	// These exact keys are pinned to Codex 0.163.0 and the initialize guard.
	// Model-declared local clock utilities may remain; application tool requests
	// are rejected by the conversation observer, never routed into task work.
	for _, key := range []string{
		"shell_tool", "stable_environment_tools", "unified_exec", "unified_exec_tty", "js_repl", "js_repl_tools_only",
		"browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use", "image_generation",
		"code_mode", "code_mode_host", "code_mode_host_grpc", "code_mode_only", "code_mode_only_strict_3p_tools",
		"code_mode_tool_search", "code_mode_prewarm", "code_mode_buffered_exec", "code_mode_interrupt",
		"multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "apps", "plugins", "hooks", "tool_suggest",
		"request_permissions_tool", "skill_mcp_dependency_install", "deferred_executor", "send_message_to_user_async",
		"current_time_reminder", "sleep_tool", "token_budget", "context_management", "view_image", "realtime_conversation",
	} {
		args = append(args, "-c", "features."+key+"=false")
	}
	return append(args, "-c", "tools.update_plan.enabled=false", "-c", `web_search="disabled"`, "app-server", "--listen", "stdio://")
}
