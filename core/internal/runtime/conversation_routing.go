package runtime

import (
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const conversationChatGPTOrigin = "https://chatgpt.com"

// The isolated transport supports only the original default public route. An
// alternate residency or workspace backend must not silently become that route.
func validateConversationRouteConfig(config contracts.RawObject) error {
	if value, present := config["chatgpt_base_url"]; present && string(value) != "null" {
		base := observerString(config, "chatgpt_base_url")
		if base != "https://chatgpt.com/backend-api" && base != "https://chatgpt.com/backend-api/" {
			return ErrInvalidProtocol
		}
	}
	if value, present := config["enforce_residency"]; present && string(value) != "null" {
		return ErrInvalidProtocol
	}
	return nil
}

func validateConversationRouting(auth conversationAuth, response contracts.RawObject) error {
	var required bool
	if json.Unmarshal(response["requiresOpenaiAuth"], &required) != nil || !required {
		return ErrInvalidProtocol
	}
	account, err := contracts.DecodeObject(response["account"], MaxRPCFrameBytes)
	if err != nil {
		return ErrInvalidProtocol
	}
	accountType := observerString(account, "type")
	if auth.account == "" && accountType != "apiKey" || auth.account != "" && accountType != "chatgpt" {
		return ErrInvalidProtocol
	}
	raw, present := response["workspaceRouting"]
	if !present || string(raw) == "null" {
		// The pinned public schema permits an omitted/nullable routing extension.
		// Its absence adds no account identity; the authenticated JWT supplies it.
		return nil
	}
	routing, err := contracts.DecodeObject(raw, MaxRPCFrameBytes)
	if err != nil || auth.account == "" || observerString(routing, "chatgptAccountId") != auth.account ||
		observerString(routing, "backendOrigin") != conversationChatGPTOrigin ||
		observerString(routing, "accountRoutingOverride") != "NO_CONSTRAINT" {
		return ErrInvalidProtocol
	}
	return nil
}
