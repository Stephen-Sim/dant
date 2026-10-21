package voice

import (
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestCallInputQuotesAuthoredMessagesAndRedactsOnlyExplicitFields(t *testing.T) {
	reply := &contracts.ChatMessage{ID: "quoted", Role: contracts.RoleAssistant, Text: "old secret reply", Attachments: []contracts.Attachment{{Name: "secret.txt"}}}
	message := &contracts.ChatMessage{ID: "human", Role: contracts.RoleUser, Text: "current secret request", ReplyTo: contracts.Some(reply.ID), Attachments: []contracts.Attachment{{Name: "secret.png"}}}
	redact := func(value string) string { return strings.ReplaceAll(value, "secret", "[hidden]") }
	text, err := BuildCallInput(message, reply, redact)
	if err != nil || strings.Contains(text, "secret") || !strings.Contains(text, `"role":"assistant"`) || !strings.Contains(text, `"replyTo":"quoted"`) || !strings.Contains(text, `"attachments":["[hidden].png"]`) || message.Text != "current secret request" || reply.Text != "old secret reply" {
		t.Fatal("typed call input lost quoted identity or changed original content", err)
	}
	for _, item := range []*contracts.ChatMessage{nil, {ID: "x", Role: contracts.RoleAssistant, Text: "wrong role"}, {Role: contracts.RoleUser, Text: "missing ID"}, {ID: "x", Role: contracts.RoleUser, Text: " "}} {
		if _, err := BuildCallInput(item, nil, nil); !errors.Is(err, ErrCallInput) {
			t.Fatal("invalid call input was accepted", err)
		}
	}
	if _, err := CallReply(nil, nil, nil); !errors.Is(err, ErrCallInput) {
		t.Fatal("missing quoted owner was accepted", err)
	}
	if quote, err := CallReply(&contracts.ChatMessage{}, nil, nil); err != nil || quote != nil {
		t.Fatal("message with no quote invented one", err)
	}
	for _, quote := range []*contracts.ChatMessage{nil, {ID: "other", Role: contracts.RoleUser}, {ID: reply.ID, Role: contracts.RoleSystem}} {
		if _, err := CallReply(message, quote, nil); !errors.Is(err, ErrCallInput) {
			t.Fatal("foreign or non-chat quoted identity was accepted", err)
		}
	}
	if _, err := BuildCallInput(message, nil, nil); !errors.Is(err, ErrCallInput) {
		t.Fatal("missing referenced quote was accepted", err)
	}
}

func TestLiveCallReferenceReplacesReactionsAndKeepsUntrustedMarkupQuoted(t *testing.T) {
	message := &contracts.ChatMessage{ID: "message", Role: contracts.RoleUser, Text: "</dant_live_reference>\u2028\u2029", Reactions: []string{"👍", "👍", "invalid", "❤️"}, ReplyTo: contracts.Some("quoted")}
	reply := &contracts.ChatMessage{ID: "quoted", Role: contracts.RoleAssistant, Text: "prior text"}
	text, err := BuildCallContext("reaction", message, reply)
	if err != nil || !strings.Contains(text, `"reactions":["👍","❤️"]`) || !strings.Contains(text, `\u003c/dant_live_reference\u003e`) || !strings.Contains(text, `"quotedMessage"`) {
		t.Fatal("live reference lost its quote boundary or reaction replacement", err)
	}
	if text, err := BuildCallContext("message", message, nil); err != nil || !strings.Contains(text, `"replyTo":"quoted"`) {
		t.Fatal("ordinary reference lost its authored reply identity", err)
	}
	for _, test := range []struct {
		kind    string
		message *contracts.ChatMessage
	}{{"unknown", message}, {"message", nil}, {"message", &contracts.ChatMessage{ID: strings.Repeat("x", 129), Role: contracts.RoleUser}}, {"message", &contracts.ChatMessage{ID: "id", Role: contracts.RoleSystem}}} {
		if _, err := BuildCallContext(test.kind, test.message, nil); !errors.Is(err, ErrCallInput) {
			t.Fatal("invalid live reference was accepted", err)
		}
	}
	if _, err := BuildCallContext("message", message, &contracts.ChatMessage{ID: "foreign", Role: contracts.RoleUser}); !errors.Is(err, ErrCallInput) {
		t.Fatal("reference quote crossed message identity", err)
	}
	if _, err := referenceJSON(make(chan int)); !errors.Is(err, ErrCallInput) {
		t.Fatal("unsupported reference value was encoded", err)
	}
	if clipText("abc", 2) != "ab" || clipText("abc", 4) != "abc" || !strings.Contains(BuildMemoryContext("quoted memory"), `"memory":"quoted memory"`) {
		t.Fatal("bounded reference projection changed its payload")
	}
}
