package voice

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestAPIProviderEventsPersistOrderedHumanAndAssistantTranscripts(t *testing.T) {
	items := make(chan ConversationItem, 4)
	usage := make(chan contracts.RawObject, 4)
	api, socket, _ := apiFixture(t, APIOptions{OnConversationItem: func(_ context.Context, item ConversationItem) error { items <- item; return nil }, Usage: func(value contracts.RawObject) { usage <- value }})
	startAPIFixture(t, api)
	socket.emit(apiEvent(`{"type":"input_audio_buffer.committed","item_id":"human","previous_item_id":null}`))
	socket.emit(apiEvent(`{"type":"conversation.item.input_audio_transcription.completed","item_id":"human","transcript":"authored human speech"}`))
	socket.emit(apiEvent(`{"type":"conversation.item.added","previous_item_id":"human","item":{"id":"assistant","type":"message","role":"assistant"}}`))
	socket.emit(apiEvent(`{"type":"response.created","response":{"id":"response"}}`))
	socket.emit(apiEvent(`{"type":"response.done","response":{"id":"response","status":"completed","conversation_id":"current","usage":{"total_tokens":3},"output":[{"id":"assistant","type":"message","role":"assistant","status":"completed","content":[{"type":"audio","transcript":"first part"},{"type":"output_audio","transcript":"second part"}]}]}}`))
	for _, expected := range []struct {
		id, text string
		role     contracts.Role
	}{{"human", "authored human speech", contracts.RoleUser}, {"assistant", "first part\nsecond part", contracts.RoleAssistant}} {
		select {
		case item := <-items:
			if item.ItemID != expected.id || item.Text != expected.text || item.Role != expected.role {
				t.Fatal("provider transcript changed its speaker or ordering", item)
			}
		case <-time.After(callLifecycleIOTimeout):
			t.Fatal("provider final transcript was not persisted")
		}
	}
	select {
	case value := <-usage:
		if textField(value, "responseId") != "response" || len(value["usage"]) == 0 {
			t.Fatal("usage receipt lost its owned response identity")
		}
	case <-time.After(callLifecycleIOTimeout):
		t.Fatal("provider response did not publish usage")
	}
	if err := api.ConversationReady(t.Context(), "fixture-call"); err != nil {
		t.Fatal("persisted conversation did not become ready", err)
	}
}

func TestAPIToolResultsUseSafeFailuresAndEndCallOnce(t *testing.T) {
	var calls atomic.Int32
	outputs := make(chan contracts.RawObject, 8)
	api, socket, hangups := apiFixture(t, APIOptions{Tool: func(_ context.Context, name string, _ contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
		if !owner.IsCurrent() || owner.CallID != "fixture-call" {
			t.Error("voice tool lost current call ownership")
		}
		calls.Add(1)
		if name == "send_message" {
			return nil, errors.New("private-fixture-cause")
		}
		return nil, nil
	}})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "conversation.item.create" {
			outputs <- objectField(event, "item")
		}
	}
	startAPIFixture(t, api)
	for _, test := range []struct {
		id, name, arguments string
		success             bool
	}{{"list", "task_list", "", true}, {"send", "send_message", `{"text":"requested delivery"}`, false}, {"invalid", "unknown_tool", `{}`, false}, {"end", "end_call", `{}`, true}} {
		item := map[string]any{"type": "function_call", "call_id": test.id, "name": test.name}
		if test.arguments != "" {
			item["arguments"] = test.arguments
		}
		socket.emit(object(map[string]any{"type": "response.done", "response": map[string]any{"status": "completed", "output": []any{item}}}))
		select {
		case output := <-outputs:
			text := textField(output, "output")
			if textField(output, "call_id") != test.id || strings.Contains(text, "private-fixture-cause") || test.success && !strings.Contains(text, "true") || !test.success && !strings.Contains(text, `"success":false`) {
				t.Fatal("tool result lost safe classification or call correlation", text)
			}
		case <-time.After(callLifecycleIOTimeout):
			t.Fatal("voice tool result was not delivered")
		}
	}
	if err := api.Close(t.Context()); err != nil || hangups.Load() != 1 || calls.Load() != 2 {
		t.Fatal("tool hangup was repeated or non-tool work executed", err)
	}
}

func TestAPIProviderFatalErrorsReleaseOwnedMediaWithFixedDiagnostics(t *testing.T) {
	for _, code := range []string{"invalid_api_key", "model_not_found", "insufficient_quota", "rate_limit_exceeded"} {
		t.Run(code, func(t *testing.T) {
			api, socket, hangups := apiFixture(t, APIOptions{})
			startAPIFixture(t, api)
			socket.emit(object(map[string]any{"type": "error", "error": map[string]any{"code": code, "message": "private-fixture-cause"}}))
			waitVoice(t, func() bool { return api.Snapshot().Call == nil })
			if err := api.Close(t.Context()); err != nil || hangups.Load() != 1 {
				t.Fatal("fatal provider error did not join its single media owner", err)
			}
			if state := api.Snapshot(); state.Error == nil || strings.Contains(*state.Error, "private-fixture-cause") {
				t.Fatal("provider diagnostics exposed raw error content")
			}
		})
	}
}
