package history

import (
	"slices"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestReactionMutationsAreScopedIdempotentAndPreserveMessageContent(t *testing.T) {
	persistence, history, _, _ := historyFixture(t)
	addFixtureMessage(t, persistence, "human", contracts.RoleUser)
	addFixtureMessage(t, persistence, "assistant", contracts.RoleAssistant)
	result, err := history.SetReactions(t.Context(), "human", fixtureConversation, []string{"👍", "❤️", "👍"})
	if err != nil || !slices.Equal(result, []string{"👍", "❤️"}) {
		t.Fatal("valid reaction order or deduplication changed", result, err)
	}
	result, err = history.ToggleReaction(t.Context(), "human", fixtureConversation, "👍")
	if err != nil || !slices.Equal(result, []string{"❤️"}) {
		t.Fatal("existing reaction was not removed", result, err)
	}
	result, err = history.ToggleReaction(t.Context(), "human", fixtureConversation, "🎉")
	if err != nil || !slices.Equal(result, []string{"❤️", "🎉"}) {
		t.Fatal("new reaction was not appended", result, err)
	}
	for _, test := range []struct {
		reaction contracts.Optional[string]
		changed  bool
	}{{contracts.Null[string](), false}, {contracts.Some("👀"), true}, {contracts.Some("👀"), false}, {contracts.Null[string](), true}} {
		changed, err := history.SetAssistantReaction(t.Context(), "human", fixtureConversation, test.reaction)
		if err != nil || changed != test.changed {
			t.Fatal("assistant reaction did not retain idempotent semantics", changed, err)
		}
	}
	message, err := persistence.Message("human")
	if err != nil || message.Text != "original" || message.ReactionUpdatedAt.Value != persistence.Timestamp() || message.AssistantReactionUpdatedAt.Value != persistence.Timestamp() || !message.AssistantReaction.Null || message.TurnID.Present {
		t.Fatal("reaction mutation changed task ownership or message content", err)
	}
	if string(reactionJSON(result)) != `["❤️","🎉"]` {
		t.Fatal("reaction projection changed authored emoji")
	}
}

func TestReactionMutationsRejectInvalidTargetsAndStaleConversation(t *testing.T) {
	persistence, history, _, _ := historyFixture(t)
	addFixtureMessage(t, persistence, "human", contracts.RoleUser)
	addFixtureMessage(t, persistence, "assistant", contracts.RoleAssistant)
	if _, err := history.SetReactions(t.Context(), "human", fixtureConversation, make([]string, 65)); err == nil {
		t.Fatal("oversized reaction list was accepted")
	}
	for _, bad := range []string{"not emoji", "👍👍", "\xff"} {
		if _, err := history.SetReactions(t.Context(), "human", fixtureConversation, []string{bad}); err == nil {
			t.Fatal("invalid reaction list was accepted")
		}
		if _, err := history.ToggleReaction(t.Context(), "human", fixtureConversation, bad); err == nil {
			t.Fatal("invalid reaction toggle was accepted")
		}
		if _, err := history.SetAssistantReaction(t.Context(), "human", fixtureConversation, contracts.Some(bad)); err == nil {
			t.Fatal("invalid assistant reaction was accepted")
		}
	}
	if _, err := history.SetAssistantReaction(t.Context(), "human", fixtureConversation, contracts.Optional[string]{}); err == nil {
		t.Fatal("omitted assistant reaction was interpreted as null")
	}
	for _, test := range []struct{ id, conversation string }{{"human", "other"}, {"missing", fixtureConversation}} {
		if _, err := history.SetReactions(t.Context(), test.id, test.conversation, []string{"👍"}); err == nil {
			t.Fatal("stale or missing reaction target was accepted")
		}
		if _, err := history.ToggleReaction(t.Context(), test.id, test.conversation, "👍"); err == nil {
			t.Fatal("stale or missing toggle target was accepted")
		}
		if _, err := history.SetAssistantReaction(t.Context(), test.id, test.conversation, contracts.Some("👍")); err == nil {
			t.Fatal("stale or missing assistant reaction target was accepted")
		}
	}
	if _, err := history.SetAssistantReaction(t.Context(), "assistant", fixtureConversation, contracts.Some("👍")); err == nil {
		t.Fatal("assistant reacted to itself as a user")
	}
	message, _ := persistence.Message("human")
	if len(message.Reactions) != 0 || message.ReactionUpdatedAt.Present || message.AssistantReaction.Present {
		t.Fatal("rejected mutation changed saved reactions")
	}
}
