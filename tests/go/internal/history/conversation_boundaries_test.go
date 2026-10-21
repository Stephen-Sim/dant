package history

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestConversationSemanticComparisonPreservesKindsNestedArraysAndDistinctLegacyUnits(t *testing.T) {
	for _, item := range []struct {
		left, right string
		equal       bool
	}{
		{``, `1`, false}, {`"x"`, `1`, false}, {`{}`, `[]`, false}, {`[]`, `{}`, false},
		{`[1,"x",{"a":2}]`, `[1.0,"\u0078",{"a":2.0}]`, true},
		{`[1]`, `[2]`, false}, {`[1]`, `[]`, false}, {`[`, `[]`, false},
		{`{"a":1}`, `{"a":2}`, false}, {`{"a":1}`, `{"a":1,"b":2}`, false},
		{`1`, `1.0`, true}, {`true`, `false`, false}, {`null`, `0`, false},
	} {
		if actual := sameContextJSON(json.RawMessage(item.left), json.RawMessage(item.right)); actual != item.equal {
			t.Fatal("semantic comparison changed JSON kind, order or literal meaning")
		}
	}
	for _, value := range []string{`null`, `false`, `[3]`} {
		if contextStringList(json.RawMessage(value)) {
			t.Fatal("invalid attachment display list accepted")
		}
	}
	if _, valid := contextID(json.RawMessage(`"control\u0001"`)); valid {
		t.Fatal("control-bearing identifier accepted")
	}
	if _, err := contextObject(json.RawMessage(`[]`)); !errors.Is(err, ErrConversationContext) {
		t.Fatal("non-object context accepted")
	}
}

func TestConversationTypedReferencesValidateQuotesAndDeduplicateOnlyEqualContent(t *testing.T) {
	thread := json.RawMessage(`{"id":"thread","turns":[]}`)
	base := contracts.RawObject{
		"conversationId": json.RawMessage(`"conversation"`), "callId": json.RawMessage(`"call"`),
		"messageId": json.RawMessage(`"typed"`), "role": json.RawMessage(`"user"`),
		"text": json.RawMessage(`"typed content"`), "at": json.RawMessage(`1000`),
		"submission": json.RawMessage(`"submitted"`), "replyTo": json.RawMessage(`"original"`),
		"quotedMessage": json.RawMessage(`{"messageId":"original","role":"assistant","text":"quoted","attachments":["report.txt"]}`),
		"attachments":   json.RawMessage(`[]`),
	}
	encoded := marshalContext(base)
	duplicate := make(contracts.RawObject)
	for key, value := range base {
		duplicate[key] = value
	}
	duplicate["submission"] = json.RawMessage(`"unknown"`)
	voice := []json.RawMessage{
		json.RawMessage(`{"callId":"call","itemId":"later","role":"assistant","text":"later","at":2000}`),
		json.RawMessage(`{"callId":"call","itemId":"earlier","role":"user","text":"earlier","at":500}`),
		json.RawMessage(`{"callId":"call","itemId":"equal","role":"user","text":"equal","at":1000}`),
	}
	result, err := BuildConversationContext(thread, "thread", voice, []json.RawMessage{encoded, marshalContext(duplicate)}, "conversation")
	if err != nil || strings.Count(result, `"source":"call-text"`) != 1 || !strings.Contains(result, `"quotedMessage":{"attachments":["report.txt"]`) || strings.Index(result, `"text":"earlier"`) > strings.Index(result, `"text":"later"`) {
		t.Fatal("typed reference lost quote scope, deduplication or chronology", err)
	}
	for _, mutation := range []struct{ key, raw string }{
		{"replyTo", `true`}, {"replyTo", `"different"`}, {"quotedMessage", `[]`},
		{"quotedMessage", `{"messageId":"original","role":"system","text":"bad","attachments":[]}`},
		{"attachments", `[true]`}, {"submission", `"accepted"`},
	} {
		changed := make(contracts.RawObject)
		for key, value := range base {
			changed[key] = value
		}
		changed[mutation.key] = json.RawMessage(mutation.raw)
		if _, err := BuildConversationContext(thread, "thread", nil, []json.RawMessage{marshalContext(changed)}, "conversation"); !errors.Is(err, ErrConversationContext) {
			t.Fatal("invalid quote, scope or delivery metadata accepted", err)
		}
	}
	duplicate["text"] = json.RawMessage(`"different content"`)
	if _, err := BuildConversationContext(thread, "thread", nil, []json.RawMessage{encoded, marshalContext(duplicate)}, "conversation"); !errors.Is(err, ErrConversationContext) {
		t.Fatal("conflicting duplicate typed identity accepted", err)
	}
}

func TestConversationTurnsRejectMalformedCanonicalMessagesAndSkipUnrelatedProviderItems(t *testing.T) {
	for _, item := range []string{
		`{"id":"thread","turns":[true]}`,
		`{"id":"thread","turns":[{"id":"turn","items":[{"type":"agentMessage","id":"","text":"x"}]}]}`,
		`{"id":"thread","turns":[{"id":"turn","items":[{"type":"userMessage","id":"message","content":null}]}]}`,
		`{"id":"thread","turns":[{"id":"turn","items":[{"type":"userMessage","id":"message","content":[{"type":"text","text":3}]}]}]}`,
		`{"id":"thread","turns":[{"id":"turn","items":[{"type":"agentMessage","id":"message","text":3}]}]}`,
	} {
		if _, err := BuildConversationContext(json.RawMessage(item), "thread", nil, nil, "conversation"); !errors.Is(err, ErrConversationContext) {
			t.Fatal("invalid canonical message entered shared reference", err)
		}
	}
	if _, err := BuildConversationContext(json.RawMessage(`{"id":"thread","turns":[]}`), "", nil, nil, ""); !errors.Is(err, ErrConversationContext) {
		t.Fatal("missing expected thread identity accepted")
	}
	thread := json.RawMessage(`{"id":"thread","turns":[{"id":"turn","items":[true,{"id":"tool","type":"toolCall","text":"private"},{"id":"empty","type":"agentMessage","text":""},{"id":"user","type":"userMessage","content":[3,{"type":"image"},{"type":"text","text":"visible"}]}]}]}`)
	result, err := BuildConversationContext(thread, "thread", nil, nil, "conversation")
	if err != nil || strings.Contains(result, "private") || strings.Contains(result, `"itemId":"empty"`) || !strings.Contains(result, `"text":"visible"`) {
		t.Fatal("provider/tool data acquired a canonical chat role", err)
	}
	for _, attachment := range []bool{false, true} {
		legacy := contracts.LegacyJSON{Original: map[string]json.RawMessage{"text": json.RawMessage(`"broken`), "name": json.RawMessage(`"broken`)}, Decoded: map[string]string{"text": "broken", "name": "broken"}}
		message := &contracts.ChatMessage{ID: "human", Role: contracts.RoleUser, Text: "broken", LegacyText: legacy}
		if attachment {
			message.Text, message.LegacyText = "valid", contracts.LegacyJSON{}
			message.Attachments = []contracts.Attachment{{Name: "broken", LegacyText: legacy}}
		}
		if _, err := BuildAPIConversationContext([]*contracts.ChatMessage{message}, false); !errors.Is(err, ErrConversationContext) {
			t.Fatal("API voice reference accepted malformed retained JSON text", err)
		}
	}
}
