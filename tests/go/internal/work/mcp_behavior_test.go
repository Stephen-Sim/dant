package work

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func mcpBehaviorItem(id, tool string, arguments, payload contracts.RawObject) contracts.RawObject {
	return contracts.RawObject{
		"id": raw(id), "type": raw("mcpToolCall"), "server": raw("dant_desktop"),
		"status": raw("completed"), "tool": raw(tool), "arguments": raw(arguments),
		"result": raw(contracts.RawObject{"structuredContent": raw(payload)}),
	}
}

func mcpBehaviorEvent(owner ToolContext, item contracts.RawObject) runtime.Event {
	return runtimeEvent("item/completed", contracts.RawObject{"threadId": raw(owner.ThreadID), "item": raw(item)}, owner.TurnID)
}

func TestCompletedMCPMessageReceiptsRequireMatchingArgumentsAndDeliverOnlyOnce(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-message-turn")
	text := "Verified isolated result 😀"
	item := mcpBehaviorItem("message-receipt", "send_chat_message", contracts.RawObject{"text": raw(text)}, contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw(text)})})
	for range 2 {
		if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item)); err != nil {
			t.Fatal(err)
		}
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 2 || state.Messages[1].Text != text || state.Messages[1].TaskID.Value != message.ID || len(state.WorkTasks) != 0 {
		t.Fatal("MCP chat delivery duplicated output, changed its owner or invented a task")
	}

	fallbackText := "Text content receipt"
	fallback := mcpBehaviorItem("fallback-receipt", "send_chat_message", contracts.RawObject{"text": raw(fallbackText)}, nil)
	fallback["error"] = raw(false)
	fallback["result"] = raw(contracts.RawObject{
		"isError": raw(false),
		"content": raw([]contracts.RawObject{{"type": raw("text"), "text": raw(string(raw(contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw(fallbackText)})})))}}),
	})
	if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, fallback)); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	if len(state.Messages) != 3 || state.Messages[2].Text != fallbackText {
		t.Fatal("a valid bounded text receipt was not delivered through the same owned channel")
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	late := mcpBehaviorItem("retired-receipt", "send_chat_message", contracts.RawObject{"text": raw("late")}, contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw("late")})})
	if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, late)); err != nil || len(persistence.Snapshot().Messages) != 3 {
		t.Fatal("a retired turn delivered a late MCP receipt", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestForgedOrMalformedMCPReceiptsCannotPublishUnverifiedContent(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-validation-turn")
	valid := func() contracts.RawObject {
		return mcpBehaviorItem("validated-receipt", "send_chat_message", contracts.RawObject{"text": raw("requested result")}, contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw("requested result")})})
	}
	mutations := []struct {
		name   string
		change func(contracts.RawObject)
	}{
		{"foreign-server", func(item contracts.RawObject) { item["server"] = raw("foreign") }},
		{"unfinished-tool", func(item contracts.RawObject) { item["status"] = raw("running") }},
		{"reported-error", func(item contracts.RawObject) { item["error"] = raw(true) }},
		{"unsupported-tool", func(item contracts.RawObject) { item["tool"] = raw("run_command") }},
		{"invalid-result", func(item contracts.RawObject) { item["result"] = raw([]string{}) }},
		{"is-error", func(item contracts.RawObject) { item["result"] = raw(contracts.RawObject{"isError": raw(true)}) }},
		{"empty-fallback", func(item contracts.RawObject) {
			item["result"] = raw(contracts.RawObject{"content": raw([]contracts.RawObject{})})
		}},
		{"nontext-fallback", func(item contracts.RawObject) {
			item["result"] = raw(contracts.RawObject{"content": raw([]contracts.RawObject{{"type": raw("image"), "text": raw("{}")}})})
		}},
		{"malformed-fallback", func(item contracts.RawObject) {
			item["result"] = raw(contracts.RawObject{"content": raw([]contracts.RawObject{{"type": raw("text"), "text": raw("invalid JSON")}})})
		}},
		{"oversized-fallback", func(item contracts.RawObject) {
			item["result"] = raw(contracts.RawObject{"content": raw([]contracts.RawObject{{"type": raw("text"), "text": raw(strings.Repeat("😀", maxMCPDeliveryTextCharacters/2+1))}})})
		}},
		{"missing-delivery", func(item contracts.RawObject) {
			item["result"] = raw(contracts.RawObject{"structuredContent": raw(contracts.RawObject{})})
		}},
		{"invalid-arguments", func(item contracts.RawObject) { item["arguments"] = raw([]string{}) }},
		{"different-text", func(item contracts.RawObject) {
			item["arguments"] = raw(contracts.RawObject{"text": raw("different requested text")})
		}},
		{"different-unpaired-units", func(item contracts.RawObject) {
			item["arguments"] = json.RawMessage(`{"text":"\ud800"}`)
			item["result"] = json.RawMessage(`{"structuredContent":{"dantMessage":{"text":"\ud801"}}}`)
		}},
	}
	for _, fixture := range mutations {
		t.Run(fixture.name, func(t *testing.T) {
			item := valid()
			fixture.change(item)
			if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item)); err != nil {
				t.Fatal(err)
			}
			if len(persistence.Snapshot().Messages) != 1 {
				t.Fatal("unverified MCP content reached persisted chat")
			}
		})
	}
	missingID := valid()
	delete(missingID, "id")
	if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, missingID)); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("delivery without an idempotency identity was accepted", err)
	}
	if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, valid())); err != nil || len(persistence.Snapshot().Messages) != 2 {
		t.Fatal("rejected receipts consumed an unrelated valid delivery identity", err)
	}
}

func TestMCPReactionReceiptsRequireExactTargetAndSupportExplicitRemoval(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-reaction-turn")
	for index, emoji := range []json.RawMessage{raw("👍"), raw(nil)} {
		arguments := contracts.RawObject{"messageId": raw(message.ID), "emoji": emoji}
		payload := contracts.RawObject{"dantReaction": raw(arguments)}
		item := mcpBehaviorItem([]string{"reaction-added", "reaction-removed"}[index], "react_message", arguments, payload)
		if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item)); err != nil {
			t.Fatal(err)
		}
		stored, err := persistence.Message(message.ID)
		if err != nil || !stored.AssistantReaction.Present || stored.AssistantReaction.Null != (index == 1) || index == 0 && stored.AssistantReaction.Value != "👍" {
			t.Fatal("reaction receipt changed its intended target or lost explicit removal", err)
		}
	}
	for _, arguments := range []contracts.RawObject{
		{"messageId": raw("different-message"), "emoji": raw("👍")},
		{"messageId": raw(message.ID), "emoji": raw("not a reaction")},
		{"messageId": raw(message.ID), "emoji": raw(nil)},
	} {
		payload := contracts.RawObject{"dantReaction": raw(contracts.RawObject{"messageId": raw(message.ID), "emoji": raw("👍")})}
		item := mcpBehaviorItem("forged-reaction", "react_message", arguments, payload)
		if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item)); err != nil {
			t.Fatal(err)
		}
	}
	stored, _ := persistence.Message(message.ID)
	if !stored.AssistantReaction.Null || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("forged reaction receipt altered chat or restored a removed reaction")
	}
}

type mcpVoiceCollector struct {
	file     contracts.Attachment
	explicit int
	err      error
	path     string
}

func (*mcpVoiceCollector) CaptureBaseline(context.Context, string) (json.RawMessage, error) {
	return raw(contracts.RawObject{}), nil
}

func (*mcpVoiceCollector) Archive(context.Context, string, string, json.RawMessage) ([]contracts.Attachment, error) {
	return nil, nil
}

func (collector *mcpVoiceCollector) ArchiveExplicit(_ context.Context, input files.ArchiveInput) ([]contracts.Attachment, error) {
	collector.explicit++
	if !input.OnlyExplicit || input.IsCurrent == nil || !input.IsCurrent() || len(input.ExplicitPaths) != 1 || input.ExplicitPaths[0] != collector.path {
		return nil, ErrStaleOwner
	}
	return []contracts.Attachment{collector.file}, collector.err
}

func TestMCPVoiceFilesUseTheOwnedArchiveAndNeverRepeatAnUnknownCapture(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "delivered", true: "unknown"}[unknown], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			file := deliveryBehaviorFiles(t, 1)[0]
			collector := &mcpVoiceCollector{file: file, path: filepath.Join(worker.root, "synthetic.wav")}
			if unknown {
				collector.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
			}
			engine.options.Deliverables = collector
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-voice-turn")
			item := mcpBehaviorItem("voice-receipt", "create_voice_message", contracts.RawObject{"text": raw("isolated speech")}, contracts.RawObject{"voiceFile": raw(contracts.RawObject{"path": raw(collector.path)})})
			for _, invalid := range []string{"relative.wav", collector.path + "\x00"} {
				bad := mcpBehaviorItem("invalid-voice", "create_voice_message", nil, contracts.RawObject{"voiceFile": raw(contracts.RawObject{"path": raw(invalid)})})
				if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, bad)); err != nil || collector.explicit != 0 {
					t.Fatal("invalid voice path reached the archive boundary", err)
				}
			}
			err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item))
			if unknown && !operationUnknown(err) || !unknown && err != nil {
				t.Fatal("voice receipt changed the archive's outcome semantics", err)
			}
			if err := engine.Handle(context.Background(), mcpBehaviorEvent(owner, item)); err != nil || collector.explicit != 1 {
				t.Fatal("a voice receipt repeated a completed or uncertain archive", err)
			}
			state := persistence.Snapshot()
			if unknown && len(state.Messages) != 1 || !unknown && (len(state.Messages) != 2 || len(state.Messages[1].Attachments) != 1 || state.Messages[1].Attachments[0].Hash != file.Hash) {
				t.Fatal("voice delivery lost its verified bytes or published an uncertain file")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
