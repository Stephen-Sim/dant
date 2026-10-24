package store

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScopedMessageAddChecksPersistedConversationWithoutChangingRejectedState(t *testing.T) {
	value, directory := openFixture(t)
	conversation := value.ConversationID()
	message, err := value.AddConversation(t.Context(), conversation, &contracts.ChatMessage{ID: "scoped-input", Role: contracts.RoleUser, Text: "Authored request"})
	if err != nil || message.ID != "scoped-input" || message.Text != "Authored request" {
		t.Fatal("scoped admission lost authored input", err)
	}
	if err := value.Mutate(t.Context(), func(state *contracts.State) error {
		state.ConversationID = UUID()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	for _, stale := range []string{"", conversation} {
		if _, err := value.AddConversation(t.Context(), stale, &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Never append this old input"}); !errors.Is(err, ErrMessageConflict) {
			t.Fatal("retired conversation appended a new message", err)
		}
	}
	after, err := os.ReadFile(filepath.Join(directory, stateFileName))
	if err != nil || !bytes.Equal(before, after) || len(value.Snapshot().Messages) != 1 {
		t.Fatal("rejected scoped admission changed persisted state", err)
	}
}
