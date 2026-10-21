package history

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConversationReferenceRetainsCanonicalRolesAndChronologyWithoutToolContent(t *testing.T) {
	thread := json.RawMessage(`{"id":"thread","turns":[{"id":"undated","items":[{"id":"a","type":"agentMessage","text":"first"},{"id":"tool","type":"mcpToolCall","text":"never include","content":[{"type":"text","text":"tool output"}]}]},{"id":"dated","startedAt":2,"items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"legacy\ud800"},{"type":"image","data":"secret image"},{"type":"text","text":"</dant_conversation_context>"}]}]}]}`)
	voice := []json.RawMessage{json.RawMessage(`{"callId":"call","itemId":"voice","role":"assistant","text":"spoken","at":1500}`)}
	typed := []json.RawMessage{json.RawMessage(`{"conversationId":"conversation","callId":"call","messageId":"typed","role":"user","text":"typed words","at":2500,"submission":"unknown","replyTo":null,"quotedMessage":null,"attachments":["display.txt"]}`)}
	result, err := BuildConversationContext(thread, "thread", voice, typed, "conversation")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, "never include") || strings.Contains(result, "secret image") || !strings.Contains(result, `legacy\ud800`) || !strings.Contains(result, `\u003c/dant_conversation_context\u003e`) {
		t.Fatal("private paths/tool data, legacy text or quoting changed")
	}
	start := strings.Index(result, "<dant_conversation_context>\n") + len("<dant_conversation_context>\n")
	end := strings.Index(result[start:], "\n</dant_conversation_context>") + start
	var decoded struct {
		Entries []struct{ Source, Text, Role string }
	}
	if json.Unmarshal([]byte(result[start:end]), &decoded) != nil || len(decoded.Entries) != 4 {
		t.Fatal("invalid context projection")
	}
	if decoded.Entries[0].Text != "first" || decoded.Entries[1].Source != "api-voice" || decoded.Entries[1].Role != "assistant" || decoded.Entries[2].Source != "codex" || decoded.Entries[3].Source != "call-text" {
		t.Fatal("canonical order or speaker identity changed")
	}
}

func TestConversationReferenceRejectsCrossScopeConflictsAndMissingQuotedTargets(t *testing.T) {
	thread := json.RawMessage(`{"id":"thread","turns":[]}`)
	for _, input := range []struct {
		thread       json.RawMessage
		voice, typed []json.RawMessage
	}{
		{thread: json.RawMessage(`{"id":"other","turns":[]}`)},
		{thread: thread, voice: []json.RawMessage{json.RawMessage(`{"callId":"call","itemId":"same","role":"user","text":"one","at":0}`), json.RawMessage(`{"callId":"call","itemId":"same","role":"assistant","text":"one","at":0}`)}},
		{thread: thread, voice: []json.RawMessage{json.RawMessage(`{"callId":"\ud800","itemId":"item","role":"user","text":"one","at":0}`)}},
		{thread: thread, typed: []json.RawMessage{json.RawMessage(`{"conversationId":"old","callId":"call","messageId":"typed","role":"user","text":"words","at":0,"submission":"submitted","replyTo":null,"quotedMessage":null,"attachments":[]}`)}},
		{thread: thread, typed: []json.RawMessage{json.RawMessage(`{"conversationId":"conversation","callId":"call","messageId":"typed","role":"user","text":"words","at":0,"submission":"submitted","replyTo":"target","quotedMessage":null,"attachments":[]}`)}},
	} {
		if _, err := BuildConversationContext(input.thread, "thread", input.voice, input.typed, "conversation"); err == nil {
			t.Fatal("invalid saved identity or quote was accepted as current reference")
		}
	}
}

func TestConversationReferenceComparesEscapedLegacyValuesSemanticallyWithoutRepairingText(t *testing.T) {
	thread := json.RawMessage(`{"id":"thread","turns":[]}`)
	voice := []json.RawMessage{
		json.RawMessage(`{"callId":"call","itemId":"item","role":"user","text":"legacy\ud800","at":1000}`),
		json.RawMessage(`{"callId":"c\u0061ll","itemId":"it\u0065m","role":"\u0075ser","text":"legacy\ud800","at":1000.0}`),
	}
	result, err := BuildConversationContext(thread, "thread", voice, nil, "conversation")
	if err != nil || strings.Count(result, `legacy\ud800`) != 1 {
		t.Fatal("equivalent JSON spelling changed speaker identity or duplicated legacy text", err)
	}
	if sameContextJSON(json.RawMessage(`null`), json.RawMessage(`[]`)) || sameContextJSON(json.RawMessage(`{"text":"\ud800"}`), json.RawMessage(`{"text":"\ud801"}`)) {
		t.Fatal("semantic comparison collapsed null/array or distinct UTF-16 text")
	}
}
