package runtime

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const ObserverItemBytes = 64 * 1024
const ObserverAgentTextChars = 120_000

type ObserverProjection string

const (
	ObserverProjectionNone    ObserverProjection = ""
	ObserverProjectionImage   ObserverProjection = "image"
	ObserverProjectionPayload ObserverProjection = "payload"
)

var observerTypes = map[string]bool{
	"userMessage": true, "hookPrompt": true, "agentMessage": true,
	"plan": true, "reasoning": true, "commandExecution": true,
	"fileChange": true, "mcpToolCall": true, "dynamicToolCall": true,
	"collabAgentToolCall": true, "webSearch": true, "imageView": true,
	"imageGeneration": true, "enteredReviewMode": true,
	"exitedReviewMode": true, "contextCompaction": true,
}

var observerStatuses = map[string]bool{
	"inProgress": true, "completed": true, "failed": true,
	"declined": true, "interrupted": true, "cancelled": true,
}

func observerString(object contracts.RawObject, key string) string {
	var value string
	if json.Unmarshal(object[key], &value) != nil {
		return ""
	}
	return value
}

func observerIdentity(value string) bool {
	if value == "" || contracts.UTF16Length(value) > 256 {
		return false
	}
	return !strings.ContainsFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	})
}

func projectObserverItem(event Event, item contracts.RawObject, kind ObserverProjection) Event {
	result := event
	result.Params = cloneObject(event.Params)
	result.Params["item"], _ = json.Marshal(item)
	result.Projection = kind
	return result
}

func observerItemMetadata(item contracts.RawObject) contracts.RawObject {
	result := contracts.RawObject{"id": item["id"], "type": item["type"]}
	if observerStatuses[observerString(item, "status")] {
		result["status"] = item["status"]
	}
	for _, key := range []string{"exitCode", "durationMs"} {
		var value float64
		if json.Unmarshal(item[key], &value) != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		if key == "exitCode" && math.Trunc(value) != value || key == "durationMs" && value < 0 {
			continue
		}
		result[key] = item[key]
	}
	return result
}

// PrepareObserverEvent removes bulk already consumed by Codex, preserving
// control requests and exact delivery-tool receipts. Bookkeeping is excluded
// from JSON so it cannot become model context or grant new tool authority.
func PrepareObserverEvent(event Event) Event {
	if event.ID.Present || event.Projection != ObserverProjectionNone {
		return event
	}
	if event.Method == "item/agentMessage/delta" {
		units, err := contracts.DecodeJSONTextUnits(event.Params["delta"])
		if err != nil || len(units) <= ObserverAgentTextChars || !observerIdentity(observerString(event.Params, "itemId")) {
			return event
		}
		result := event
		result.Params = cloneObject(event.Params)
		result.Params["delta"] = contracts.EncodeJSONTextUnits(units[:ObserverAgentTextChars])
		result.Projection = ObserverProjectionPayload
		return result
	}
	if event.Method != "item/started" && event.Method != "item/completed" {
		return event
	}

	item, err := contracts.DecodeObject(event.Params["item"], MaxRPCFrameBytes)
	if err != nil || !observerTypes[observerString(item, "type")] || !observerIdentity(observerString(item, "id")) {
		return event
	}
	event.TaskExecutionObserved = observerExecution(item)
	observed := event
	toolResult, _ := contracts.DecodeObject(item["result"], MaxRPCFrameBytes)
	if observerString(item, "type") == "mcpToolCall" {
		var content []contracts.RawObject
		if json.Unmarshal(toolResult["content"], &content) == nil {
			changed := false
			for _, block := range content {
				if observerString(block, "type") == "image" {
					var data string
					if json.Unmarshal(block["data"], &data) == nil {
						delete(block, "data")
						changed = true
					}
				}
			}
			if changed {
				toolResult["content"], _ = json.Marshal(content)
				item["result"], _ = json.Marshal(toolResult)
				observed = projectObserverItem(event, item, ObserverProjectionImage)
			}
		}
	}

	encoded, _ := json.Marshal(item)
	if len(encoded) <= ObserverItemBytes {
		return observed
	}
	if observerString(item, "type") == "agentMessage" {
		text, err := contracts.SliceJSONText(item["text"], ObserverAgentTextChars)
		if err != nil {
			return observed
		}
		metadata := observerItemMetadata(item)
		metadata["text"] = text
		return projectObserverItem(observed, metadata, ObserverProjectionPayload)
	}

	tool := observerString(item, "tool")
	delivery := tool == "send_chat_message" || tool == "create_voice_message" || tool == "react_message"
	if observerString(item, "type") == "mcpToolCall" && event.Method == "item/completed" && observerString(item, "server") == "dant_desktop" && delivery && observerString(item, "status") == "completed" && observerFalsy(item["error"]) && observerFalsy(toolResult["isError"]) {
		return observed
	}
	return projectObserverItem(observed, observerItemMetadata(item), ObserverProjectionPayload)
}

func observerFalsy(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) == 0 || bytes.Equal(raw, []byte("null")) || bytes.Equal(raw, []byte("false")) || bytes.Equal(raw, []byte(`""`)) || bytes.Equal(raw, []byte("0"))
}

func observerExecution(item contracts.RawObject) bool {
	switch observerString(item, "type") {
	case "commandExecution", "fileChange", "imageView", "imageGeneration", "webSearch", "collabAgentToolCall":
		return true
	case "mcpToolCall", "dynamicToolCall":
		tool := observerString(item, "tool")
		switch tool {
		case "", "task_plan", "task_list", "task_cancel", "send_message", "send_chat_message", "end_call", "react_message", "memory_write", "skill_list", "skill_get", "credential_find", "credential_get", "schedule_list", "schedule_save", "schedule_delete":
			return false
		default:
			return true
		}
	}
	return false
}
