package runtime

import (
	"bytes"
	"encoding/json"
	"math"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func protocolObject(raw json.RawMessage) (contracts.RawObject, bool) {
	object, err := contracts.DecodeObject(raw, MaxRPCFrameBytes)
	return object, err == nil
}

func validRPCError(object contracts.RawObject) bool {
	var code float64
	return !protocolNull(object["code"]) && json.Unmarshal(object["code"], &code) == nil && !math.IsInf(code, 0) && math.Trunc(code) == code && math.Abs(code) <= 9_007_199_254_740_991 && protocolString(object["message"])
}

func protocolNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func protocolString(raw json.RawMessage) bool {
	_, err := contracts.DecodeJSONTextUnits(raw)
	return err == nil
}

func optionalStrings(object contracts.RawObject, fields ...string) bool {
	for _, name := range fields {
		if raw, present := object[name]; present && !protocolString(raw) {
			return false
		}
	}
	return true
}

func protocolArray(raw json.RawMessage, valid func(json.RawMessage) bool) bool {
	var entries []json.RawMessage
	if protocolNull(raw) || json.Unmarshal(raw, &entries) != nil || entries == nil {
		return false
	}
	for _, entry := range entries {
		if !valid(entry) {
			return false
		}
	}
	return true
}

func optionalNumber(raw json.RawMessage) bool {
	if protocolNull(raw) {
		return true
	}
	var number float64
	return json.Unmarshal(raw, &number) == nil
}

func protocolIdentity(object contracts.RawObject, name string) bool {
	raw, present := object[name]
	return present && contracts.ValidUnicodeJSON(raw) && protocolString(raw)
}

func protocolContent(raw json.RawMessage) bool {
	object, valid := protocolObject(raw)
	return valid && protocolString(object["type"]) && optionalStrings(object, "text", "data", "mimeType")
}

func protocolToolResult(raw json.RawMessage) bool {
	object, valid := protocolObject(raw)
	if !valid {
		return false
	}
	if flag, present := object["isError"]; present && !bytes.Equal(flag, []byte("true")) && !bytes.Equal(flag, []byte("false")) {
		return false
	}
	if content, present := object["content"]; present {
		return protocolArray(content, func(json.RawMessage) bool { return true })
	}
	return true
}

func protocolItem(raw json.RawMessage) bool {
	item, valid := protocolObject(raw)
	if !valid || !protocolIdentity(item, "id") || !protocolString(item["type"]) || !optionalStrings(item,
		"status", "text", "role", "server", "tool", "callId", "handoff_id", "item_id", "itemId",
		"sourcePath", "cwd", "input_transcript", "realtimeSessionId", "realtime_session_id") {
		return false
	}
	for _, name := range []string{"phase", "aggregatedOutput"} {
		if value, present := item[name]; present && !protocolNull(value) && !protocolString(value) {
			return false
		}
	}
	for _, name := range []string{"exitCode", "durationMs"} {
		if value, present := item[name]; present && !optionalNumber(value) {
			return false
		}
	}
	if value, present := item["error"]; present && !protocolNull(value) && !protocolString(value) {
		object, valid := protocolObject(value)
		if !valid || !optionalStrings(object, "message") {
			return false
		}
	}
	if result, present := item["result"]; present && !protocolNull(result) && !protocolToolResult(result) {
		return false
	}
	if content, present := item["content"]; present {
		var kind string
		_ = json.Unmarshal(item["type"], &kind)
		validator := protocolContent
		if kind == "reasoning" {
			validator = protocolString
		}
		if !protocolArray(content, validator) {
			return false
		}
	}
	if changes, present := item["changes"]; present && !protocolArray(changes, func(raw json.RawMessage) bool {
		change, valid := protocolObject(raw)
		if !valid || !optionalStrings(change, "path", "diff") {
			return false
		}
		if kind, present := change["kind"]; present && !protocolString(kind) {
			object, valid := protocolObject(kind)
			return valid && optionalStrings(object, "type")
		}
		return true
	}) {
		return false
	}
	if actions, present := item["commandActions"]; present && !protocolArray(actions, func(raw json.RawMessage) bool {
		object, valid := protocolObject(raw)
		return valid && optionalStrings(object, "type")
	}) {
		return false
	}
	if transcript, present := item["active_transcript"]; present && !protocolArray(transcript, func(raw json.RawMessage) bool {
		object, valid := protocolObject(raw)
		return valid && protocolString(object["role"]) && protocolString(object["text"])
	}) {
		return false
	}
	return true
}

func protocolTurn(raw json.RawMessage) bool {
	turn, valid := protocolObject(raw)
	if !valid || !protocolIdentity(turn, "id") || !optionalStrings(turn, "status") {
		return false
	}
	if items, present := turn["items"]; present && !protocolArray(items, protocolItem) {
		return false
	}
	if started, present := turn["startedAt"]; present && !optionalNumber(started) {
		return false
	}
	if value, present := turn["error"]; present && !protocolNull(value) {
		object, valid := protocolObject(value)
		return valid && optionalStrings(object, "message")
	}
	return true
}

func protocolThread(raw json.RawMessage) bool {
	thread, valid := protocolObject(raw)
	if !valid || !protocolIdentity(thread, "id") {
		return false
	}
	if turns, present := thread["turns"]; present && !protocolArray(turns, protocolTurn) {
		return false
	}
	if status, present := thread["status"]; present && !protocolString(status) {
		object, valid := protocolObject(status)
		return valid && protocolString(object["type"])
	}
	return true
}

// ReadRPCResult validates consumed provider fields while retaining unknown
// provider extensions as opaque JSON. User text may contain legacy UTF-16;
// execution identities must never be repaired into another identity.
func ReadRPCResult(raw json.RawMessage) (contracts.RawObject, error) {
	result, valid := protocolObject(raw)
	if !valid || !optionalStrings(result, "status", "authUrl", "loginId") {
		return nil, ErrInvalidProtocol
	}
	if thread, present := result["thread"]; present && !protocolThread(thread) {
		return nil, ErrInvalidProtocol
	}
	if turn, present := result["turn"]; present && !protocolTurn(turn) {
		return nil, ErrInvalidProtocol
	}
	if account, present := result["account"]; present && !protocolNull(account) {
		object, valid := protocolObject(account)
		if !valid || !optionalStrings(object, "type", "email", "planType") {
			return nil, ErrInvalidProtocol
		}
	}
	if mode, present := result["authMode"]; present && !protocolNull(mode) && !protocolString(mode) {
		return nil, ErrInvalidProtocol
	}
	if flag, present := result["requiresOpenaiAuth"]; present && !bytes.Equal(flag, []byte("true")) && !bytes.Equal(flag, []byte("false")) {
		return nil, ErrInvalidProtocol
	}
	if voices, present := result["voices"]; present {
		object, valid := protocolObject(voices)
		if !valid {
			return nil, ErrInvalidProtocol
		}
		if version, present := object["v3"]; present && !protocolArray(version, protocolString) {
			return nil, ErrInvalidProtocol
		}
	}
	return result, nil
}
