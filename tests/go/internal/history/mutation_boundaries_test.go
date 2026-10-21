package history

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestHistoryMutationBoundariesRejectInvalidTargetsAndUnavailableAdmission(t *testing.T) {
	persistence, history, owner, _ := historyFixture(t)
	addFixtureMessage(t, persistence, "human", contracts.RoleUser)
	addFixtureMessage(t, persistence, "assistant", contracts.RoleAssistant)
	addFixtureMessage(t, persistence, "system", contracts.RoleSystem)
	for _, id := range []string{"", strings.Repeat("x", MessageIDLimit+1), "missing"} {
		if _, err := history.SetMetadata(t.Context(), id, bookmarkInput(json.RawMessage("true"))); err == nil {
			t.Fatal("invalid bookmark target accepted")
		}
		if _, err := history.Edit(t.Context(), id, "edited", false); err == nil {
			t.Fatal("invalid edit target accepted")
		}
		if _, err := history.Remove(t.Context(), id); err == nil {
			t.Fatal("invalid removal target accepted")
		}
	}
	for _, input := range []contracts.RawObject{
		{"conversationId": json.RawMessage("null"), "pinned": json.RawMessage("true")},
		{"conversationId": json.RawMessage(`"` + fixtureConversation + `"`)},
	} {
		if _, err := history.SetMetadata(t.Context(), "human", input); err == nil {
			t.Fatal("incomplete bookmark scope accepted")
		}
	}
	if _, err := history.SetMetadata(t.Context(), "system", bookmarkInput(json.RawMessage("true"))); err == nil {
		t.Fatal("system message was bookmarked")
	}
	if _, err := history.SetReactions(t.Context(), "system", fixtureConversation, []string{"👍"}); err == nil {
		t.Fatal("system message received user reactions")
	}
	if _, err := history.ToggleReaction(t.Context(), "system", fixtureConversation, "👍"); err == nil {
		t.Fatal("system message received a reaction toggle")
	}
	if _, err := history.Edit(t.Context(), "assistant", "edited", false); err == nil {
		t.Fatal("assistant message was edited as a user")
	}
	if _, err := history.Edit(t.Context(), "human", " \ufeff ", true); err == nil {
		t.Fatal("empty ECMAScript-whitespace edit accepted")
	}
	star := contracts.RawObject{"conversationId": json.RawMessage(`"` + fixtureConversation + `"`), "starred": json.RawMessage("true")}
	if result, err := history.SetMetadata(t.Context(), "human", star); err != nil || !result.Message.Starred {
		t.Fatal("star bookmark did not persist its requested flag", err)
	}
	unavailable := New(persistence, nil)
	if _, err := unavailable.Edit(t.Context(), "human", "edited", true); err == nil {
		t.Fatal("edit bypassed absent admission")
	}
	if _, err := unavailable.Remove(t.Context(), "human"); err == nil {
		t.Fatal("removal bypassed absent admission")
	}
	if _, err := unavailable.Clear(t.Context(), true); err == nil {
		t.Fatal("clear bypassed absent admission")
	}
	owner.Call = true
	if _, err := history.Remove(t.Context(), "human"); err == nil {
		t.Fatal("removal raced an active call")
	}
	owner.Call, owner.VoiceTaskIDs = false, []string{"human"}
	if _, err := history.Clear(t.Context(), true); err == nil {
		t.Fatal("clear raced a voice-owned task")
	}
	owner.VoiceTaskIDs, owner.ActiveIDs = nil, []string{"human"}
	if _, err := history.Remove(t.Context(), "human"); err == nil {
		t.Fatal("active task history was removed")
	}
}

func TestHistoryRemovalClearsReplyAndCompletionReferencesWithoutRemovingOtherResults(t *testing.T) {
	persistence, history, _, _ := historyFixture(t)
	addFixtureMessage(t, persistence, "removed", contracts.RoleUser)
	addFixtureMessage(t, persistence, "kept", contracts.RoleAssistant)
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[1].ReplyTo = contracts.Some("removed")
		state.Completions = []contracts.Completion{
			{ID: "mixed", MessageIDs: []string{"removed", "kept"}, TaskID: contracts.Some("removed")},
			{ID: "only-removed", MessageIDs: []string{"removed"}},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	result, err := history.Remove(t.Context(), "removed")
	if err != nil || !result.Removed || result.Withdrawn {
		t.Fatal("idle message removal failed", err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].ID != "kept" || !state.Messages[0].ReplyTo.Null || len(state.Completions) != 1 || len(state.Completions[0].MessageIDs) != 1 || state.Completions[0].MessageIDs[0] != "kept" || !state.Completions[0].TaskID.Null || !persistence.HasDeletedClientID("client-removed") {
		t.Fatal("removal left dangling references or removed unrelated completion output")
	}
	if _, err := message(&contracts.State{Messages: []*contracts.ChatMessage{{ID: "duplicate"}, {ID: "duplicate"}}}, "duplicate"); err == nil {
		t.Fatal("ambiguous message identity was accepted")
	}
	previous := make([]string, DeletedClientIDLimit+1)
	for index := range previous {
		previous[index] = fmt.Sprintf("client-%04d", index)
	}
	retained := deletedClientIDs(previous, []*contracts.ChatMessage{nil, {Role: contracts.RoleUser, ClientMessageID: "fresh"}, {Role: contracts.RoleUser, ClientMessageID: "fresh"}})
	if len(retained) != DeletedClientIDLimit || retained[len(retained)-1] != "fresh" || retained[0] != "client-0002" {
		t.Fatal("bounded deduplication tombstones lost their stable recency")
	}
}
