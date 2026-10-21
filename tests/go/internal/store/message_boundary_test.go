package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMessageMutationsValidateBoundariesAndDoNotBorrowCallerPatches(t *testing.T) {
	s, _ := openFixture(t)
	for _, message := range []*contracts.ChatMessage{nil, {ID: "bad", Role: "unknown"}, {ID: strings.Repeat("x", MaxMessageIDLength+1), Role: contracts.RoleUser}, {ID: "bad-raw", Role: contracts.RoleUser, Extra: contracts.RawObject{"invalid": json.RawMessage(`{`)}}} {
		if _, err := s.Add(t.Context(), message); !errors.Is(err, ErrInvalidState) {
			t.Fatal("invalid message was persisted", err)
		}
	}
	message, err := s.Add(t.Context(), &contracts.ChatMessage{ID: "human", Role: contracts.RoleUser, Text: "authored request"})
	if err != nil {
		t.Fatal(err)
	}
	patch := contracts.MessagePatch{"error": json.RawMessage(`null`)}
	if _, err := s.SetTaskState(t.Context(), message.ID, "unknown-future-state", patch); !errors.Is(err, ErrInvalidState) {
		t.Fatal("unknown task state was accepted", err)
	}
	updated, err := s.SetTaskState(t.Context(), message.ID, contracts.TaskStatusRunning, patch)
	if err != nil || updated.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) || patch["status"] != nil {
		t.Fatal("task update changed a borrowed patch or lost typed state", err)
	}
	confirmed, err := s.ConfirmExecution(t.Context(), message.ID, patch)
	if err != nil || confirmed.ExecutorConfirmedAt.Value != s.Timestamp() || patch["executorConfirmedAt"] != nil {
		t.Fatal("execution confirmation changed a borrowed patch", err)
	}
	for _, id := range []string{"", "missing", strings.Repeat("x", MaxMessageIDLength+1)} {
		if _, err := s.Message(id); !errors.Is(err, ErrMessageNotFound) {
			t.Fatal("invalid or missing message read accepted", err)
		}
	}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error { state.DeletedClientMessageIDs = []string{"deleted"}; return nil }); err != nil {
		t.Fatal(err)
	}
	if !s.HasDeletedClientID("deleted") || s.HasDeletedClientID("missing") || s.HasDeletedClientID(" ") {
		t.Fatal("deleted client identity tombstone lookup changed")
	}
}

func TestScheduledMessageMaterializationIsIdempotentAndNeverReplaysRecoveredWork(t *testing.T) {
	s, _ := openFixture(t)
	input := &contracts.ChatMessage{ID: "scheduled-message", Role: contracts.RoleUser, Text: "scheduled request", Scheduled: true, ScheduleID: "schedule", ScheduledAt: contracts.Some(float64(1000)), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))}
	if _, err := s.MaterializeScheduledMessage(t.Context(), nil, false); !errors.Is(err, ErrInvalidState) {
		t.Fatal("nil schedule materialization accepted", err)
	}
	invalid := *input
	invalid.Extra = contracts.RawObject{"invalid": json.RawMessage(`{`)}
	if _, err := s.MaterializeScheduledMessage(t.Context(), &invalid, false); !errors.Is(err, ErrInvalidState) {
		t.Fatal("malformed schedule payload was persisted", err)
	}
	first, err := s.MaterializeScheduledMessage(t.Context(), input, false)
	if err != nil || first.Time.Value != s.Timestamp() || first.ReceivedAt.Value != s.Timestamp() || !first.ExecutorConfirmedAt.Null {
		t.Fatal("scheduled materialization lost local receipt metadata", err)
	}
	again, err := s.MaterializeScheduledMessage(t.Context(), input, true)
	if err != nil || again.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || again.PauseReason.Value != "schedule-recovery" || len(s.Snapshot().Messages) != 1 {
		t.Fatal("recovery replayed or duplicated an unsubmitted schedule", err)
	}
	changed := *input
	changed.Text = "different request"
	if _, err := s.MaterializeScheduledMessage(t.Context(), &changed, false); !errors.Is(err, ErrMessageConflict) {
		t.Fatal("same scheduled identity changed authored input", err)
	}
}

func TestVisibleAttachmentSnapshotDoesNotConsumeFilesAddedAfterRendering(t *testing.T) {
	s, _ := openFixture(t)
	firstID := "4b3225c9-de47-4a39-80df-7321773d9701"
	secondID := "4b3225c9-de47-4a39-80df-7321773d9702"
	message, err := s.Add(t.Context(), &contracts.ChatMessage{ID: "assistant", Role: contracts.RoleAssistant, Text: "delivered files", Attachments: []contracts.Attachment{{ID: firstID, Name: "first.txt"}, {ID: secondID, Name: "second.txt"}}, VisibleAttachmentIDs: []string{"stale-file"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MarkVisible(t.Context(), []string{message.ID}, map[string][]string{message.ID: {firstID, "not-current"}}); err != nil {
		t.Fatal(err)
	}
	partial, err := s.Message(message.ID)
	if err != nil || partial.Read || len(partial.VisibleAttachmentIDs) != 1 || partial.VisibleAttachmentIDs[0] != firstID {
		t.Fatal("partial rendered snapshot consumed unseen attachments", err)
	}
	if err := s.MarkVisible(t.Context(), []string{message.ID}, map[string][]string{message.ID: {secondID}}); err != nil {
		t.Fatal(err)
	}
	complete, err := s.Message(message.ID)
	if err != nil || !complete.Read || len(complete.VisibleAttachmentIDs) != 2 {
		t.Fatal("complete attachment receipt lost previous visible files", err)
	}
}
