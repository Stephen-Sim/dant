package history

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPIConversationReferenceContainsVisibleSpeakersAndDisplayNamesOnly(t *testing.T) {
	var user contracts.ChatMessage
	if err := json.Unmarshal([]byte(`{"id":"user-message","role":"user","text":"legacy\ud800","assistantReaction":"👍","reactions":["👍"],"attachments":[{"id":"file","name":"visible.bin","guestPath":"/private/path.bin"}]}`), &user); err != nil {
		t.Fatal(err)
	}
	messages := []*contracts.ChatMessage{
		{ID: "system-message", Role: contracts.RoleSystem, Text: "never include system instructions"},
		&user,
		{ID: "assistant-message", Role: contracts.RoleAssistant, Text: "shared reply"},
	}
	text, err := BuildAPIConversationContext(messages, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "/private/") || strings.Contains(text, "never include") || !strings.Contains(text, `legacy\ud800`) || !strings.Contains(text, `"attachments":["visible.bin"]`) || !strings.Contains(text, `"assistantReaction":null`) {
		t.Fatal("API chat projection lost lossless text, names, null semantics or role isolation")
	}
	reactions, err := BuildAPIConversationContext(messages, true)
	if err != nil || reactions != BuildReactionContext(messages, ReactionContextOptions{}) || strings.Contains(reactions, "shared reply") || !strings.Contains(reactions, "👍") {
		t.Fatal("reaction-only update exposed the complete conversation", err)
	}
}
