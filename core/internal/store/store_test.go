package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const conversationID = "00000000-0000-4000-8000-000000000001"

func compact(raw json.RawMessage) string {
	var result bytes.Buffer
	if json.Compact(&result, raw) != nil {
		return "invalid"
	}
	return result.String()
}

func openFixture(t *testing.T) (*Store, string) {
	t.Helper()
	directory := t.TempDir()
	value, err := Open(directory, Options{Now: func() time.Time {
		return time.UnixMilli(1234)
	}, NewID: func() string {
		return conversationID
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(value.Close)
	return value, directory
}

func TestAtomicMutationPreservesFutureFieldsAndUnpairedLegacyText(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, stateFileName)
	legacy := `{"version":2,"conversationId":"` + conversationID + `","messages":[{"id":"assistant","role":"assistant","text":"old\ud800text","time":50,"reactions":[],"read":false,"pinned":false,"futureMessage":{"a":1}}],"settings":{"language":"en","voice":"marin","notifications":true,"showCallCaptions":false,"vm":{"user":"dant","port":22,"futureVm":true},"futureSetting":4},"completions":[],"workTasks":[],"futureState":[1,2]}`
	if err := os.WriteFile(file, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer value.Close()
	if err = value.MarkVisible(context.Background(), []string{"assistant"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = value.Update(context.Background(), "assistant", contracts.MessagePatch{"starred": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var persisted contracts.State
	if json.Unmarshal(raw, &persisted) != nil {
		t.Fatal("saved state is invalid")
	}
	message := persisted.Messages[0]
	encoded, err := json.Marshal(message)
	if err != nil || !bytes.Contains(encoded, []byte(`"text":"old\ud800text"`)) || message.Time.Value != 50 || !message.Read || !message.Starred.Value {
		t.Fatal("unrelated metadata/read change altered legacy content or time")
	}
	if compact(persisted.Extra["futureState"]) != "[1,2]" || compact(message.Extra["futureMessage"]) != `{"a":1}` || compact(persisted.Settings.Extra["futureSetting"]) != "4" || compact(persisted.Settings.VM.Extra["futureVm"]) != "true" || persisted.Settings.ShowCallCaptions {
		t.Fatal("future/false fields were lost")
	}
	if _, err = value.Update(context.Background(), "assistant", contracts.MessagePatch{"text": json.RawMessage(`"replacement"`)}); err != nil {
		t.Fatal(err)
	}
	updated, _ := os.ReadFile(file)
	if bytes.Contains(updated, []byte(`\ud800`)) {
		t.Fatal("an explicit text edit resurrected old content")
	}
}

func TestFailedWriteAndBorrowedSnapshotsCannotChangeAuthoritativeState(t *testing.T) {
	value, directory := openFixture(t)
	message, err := value.Add(context.Background(), &contracts.ChatMessage{ID: "message", Role: contracts.RoleUser, Text: "original"})
	if err != nil {
		t.Fatal(err)
	}
	message.Text = "caller changed returned value"
	snapshot := value.Snapshot()
	snapshot.Messages[0].Text = "caller changed snapshot"
	if value.Snapshot().Messages[0].Text != "original" {
		t.Fatal("public pointers changed authoritative state")
	}
	before, _ := os.ReadFile(filepath.Join(directory, stateFileName))
	value.write = func(context.Context, string, []byte, fs.FileMode) error {
		return errors.New("private failure")
	}
	if _, err = value.Update(context.Background(), "message", contracts.MessagePatch{"text": json.RawMessage(`"unsaved"`)}); !errors.Is(err, ErrPersistence) {
		t.Fatal("write failure was not retained")
	}
	after, _ := os.ReadFile(filepath.Join(directory, stateFileName))
	if !bytes.Equal(before, after) || value.Snapshot().Messages[0].Text != "original" {
		t.Fatal("failed write leaked partial state")
	}
	value.write = files.WriteAtomic
	for _, key := range []string{"id", "role", "time", "ts"} {
		if _, err = value.Update(context.Background(), "message", contracts.MessagePatch{key: json.RawMessage(`null`)}); err == nil {
			t.Fatal("message identity/time patch was accepted")
		}
	}
}

func TestRestartDoesNotTurnUnknownSubmissionIntoSafeRetry(t *testing.T) {
	value, directory := openFixture(t)
	_, err := value.Add(context.Background(), &contracts.ChatMessage{ID: "pending", Role: contracts.RoleUser, Text: "accepted", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusRunning)), Submission: contracts.Some(contracts.SubmissionStatusSubmitting), Time: contracts.Some(float64(40))})
	if err != nil {
		t.Fatal(err)
	}
	value.Close()
	restored, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	message, err := restored.Message("pending")
	if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusUnknown) || message.Submission.Value != contracts.SubmissionStatusUnknown || !message.UnknownOutcome || message.Time.Value != 40 {
		t.Fatal("restart invented a safe execution or timestamp")
	}
}

func TestScheduledMaterializationFencesIdentityAndMergesAnotherStoreWriter(t *testing.T) {
	first, directory := openFixture(t)
	second, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	input := &contracts.ChatMessage{ID: "scheduled", Role: contracts.RoleUser, Text: "scheduled task", Scheduled: true, ScheduleID: "schedule", ScheduledAt: contracts.Some(float64(1000)), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued)), Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted)}
	message, err := first.MaterializeScheduledMessage(context.Background(), input, false)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := second.MaterializeScheduledMessage(context.Background(), input, true)
	if err != nil || restored.Time != message.Time || restored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || restored.PauseReason.Value != "schedule-recovery" {
		t.Fatal("schedule recovery changed identity/time or requeued work")
	}
	if _, err = first.Add(context.Background(), &contracts.ChatMessage{ID: "other", Role: contracts.RoleAssistant, Text: "other"}); err != nil {
		t.Fatal(err)
	}
	if len(first.Snapshot().Messages) != 2 {
		t.Fatal("a stale Store writer lost a persisted scheduled message")
	}
	changed := *input
	changed.Text = "different"
	if _, err = second.MaterializeScheduledMessage(context.Background(), &changed, false); !errors.Is(err, ErrMessageConflict) {
		t.Fatal("conflicting schedule identity was accepted")
	}
}

func TestLateAttachmentReceiptDoesNotReadAnUnseenFile(t *testing.T) {
	value, _ := openFixture(t)
	ctx := context.Background()
	_, err := value.Add(ctx, &contracts.ChatMessage{ID: "assistant", Role: contracts.RoleAssistant, Text: "files", Attachments: []contracts.Attachment{{ID: "first"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = value.MarkVisible(ctx, []string{"assistant"}, map[string][]string{"assistant": {"first"}}); err != nil {
		t.Fatal(err)
	}
	_, err = value.Update(ctx, "assistant", contracts.MessagePatch{"attachments": json.RawMessage(`[{"id":"first"},{"id":"second"}]`)})
	if err != nil {
		t.Fatal(err)
	}
	if err = value.MarkVisible(ctx, []string{"assistant"}, map[string][]string{"assistant": {"first"}}); err != nil {
		t.Fatal(err)
	}
	message, _ := value.Message("assistant")
	if message.Read || len(message.VisibleAttachmentIDs) != 1 {
		t.Fatal("late receipt consumed a newly appended file")
	}
}
