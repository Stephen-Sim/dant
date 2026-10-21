package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScopedMessageUpdateRetainsPatchValidationAndRefusesReplacementIdentity(t *testing.T) {
	value, directory := openFixture(t)
	message, err := value.Add(context.Background(), &contracts.ChatMessage{ID: "scoped-message", Role: contracts.RoleUser, Text: "retained exact text"})
	if err != nil {
		t.Fatal(err)
	}
	patch := contracts.MessagePatch{"starred": json.RawMessage(`true`)}
	if _, err := value.UpdateConversation(context.Background(), value.ConversationID(), message.ID, patch); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "role", "time", "ts"} {
		if _, err := value.UpdateConversation(context.Background(), value.ConversationID(), message.ID, contracts.MessagePatch{key: json.RawMessage(`null`)}); !errors.Is(err, ErrInvalidState) {
			t.Fatal("scoped update bypassed immutable message identity", err)
		}
	}
	previous := value.ConversationID()
	if err := value.Mutate(context.Background(), func(state *contracts.State) error {
		state.ConversationID = UUID()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	for _, stale := range []string{"", previous} {
		if _, err := value.UpdateConversation(context.Background(), stale, message.ID, contracts.MessagePatch{"text": json.RawMessage(`"old result"`)}); !errors.Is(err, ErrMessageConflict) {
			t.Fatal("retired conversation updated a matching current message ID", err)
		}
	}
	after, err := os.ReadFile(filepath.Join(directory, stateFileName))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("rejected scoped update changed persisted bytes", err)
	}
	value.Close()
	reopened, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	retained, err := reopened.Message(message.ID)
	if err != nil || retained.Text != message.Text || !retained.Starred.Value || retained.Time != message.Time {
		t.Fatal("scoped update lost unrelated content, time or metadata", err)
	}
}
