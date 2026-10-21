package history

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const fixtureConversation = "00000000-0000-4000-8000-000000000001"

func historyFixture(t *testing.T) (*store.Store, *History, *Ownership, *int) {
	t.Helper()
	persistence, err := store.Open(t.TempDir(), store.Options{Now: func() time.Time {
		return time.UnixMilli(1000)
	}, NewID: func() string {
		return fixtureConversation
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(persistence.Close)
	owner := &Ownership{}
	calls := new(int)
	admit := func(
		ctx context.Context,
		change func(Ownership) (QueueChange, error)) error {
		*calls++
		queue, err := change(*owner)
		if err != nil {
			return err
		}
		if queue.Clear {
			owner.Queue = []string{}
		}
		if queue.WithdrawID != "" {
			remaining := []string{}
			for _, id := range owner.Queue {
				if id != queue.WithdrawID {
					remaining = append(remaining, id)
				}
			}
			owner.Queue = remaining
		}
		if queue.EnqueueID != "" && !contains(owner.Queue, queue.EnqueueID) {
			owner.Queue = append(owner.Queue, queue.EnqueueID)
		}
		return nil
	}
	return persistence, New(persistence, admit), owner, calls
}

func addFixtureMessage(t *testing.T, persistence *store.Store, id string, role contracts.Role) {
	t.Helper()
	if _, err := persistence.Add(context.Background(), &contracts.ChatMessage{ID: id, Role: role, Text: "original", ClientMessageID: "client-" + id}); err != nil {
		t.Fatal(err)
	}
}

func bookmarkInput(pinned json.RawMessage) contracts.RawObject {
	return contracts.RawObject{"conversationId": json.RawMessage(`"` + fixtureConversation + `"`), "pinned": pinned}
}

func TestBookmarksDuringActiveCallOnlyChangeTheirRequestedFlags(t *testing.T) {
	persistence, value, owner, calls := historyFixture(t)
	addFixtureMessage(t, persistence, "assistant", contracts.RoleAssistant)
	owner.Call = true
	owner.ActiveIDs = []string{"assistant"}
	receipt, err := value.SetMetadata(context.Background(), "assistant", bookmarkInput(json.RawMessage(`true`)))
	if err != nil || !receipt.Message.Pinned || receipt.Message.Starred {
		t.Fatal("active-call bookmark failed")
	}
	message, _ := persistence.Message("assistant")
	if *calls != 0 || message.Read || message.Status.Present || message.TurnID.Present {
		t.Fatal("bookmark started work, read the message or invented execution identity")
	}
	for _, invalid := range []contracts.RawObject{bookmarkInput(json.RawMessage(` null `)), {"conversationId": json.RawMessage(`"stale"`), "pinned": json.RawMessage(`true`)}, {"conversationId": json.RawMessage(`"` + fixtureConversation + `"`), "pinned": json.RawMessage(`false`), "read": json.RawMessage(`true`)}} {
		if _, err = value.SetMetadata(context.Background(), "assistant", invalid); err == nil {
			t.Fatal("invalid/stale metadata was accepted")
		}
	}
}

func TestEditResubmissionKeepsQueueIdentityAndExecutorThread(t *testing.T) {
	persistence, value, owner, _ := historyFixture(t)
	ctx := context.Background()
	addFixtureMessage(t, persistence, "human", contracts.RoleUser)
	owner.ActiveIDs = []string{"other"}
	if _, err := value.Edit(ctx, "human", "changed", true); err == nil {
		t.Fatal("edit raced active work")
	}
	owner.ActiveIDs = nil
	owner.Queue = []string{"human"}
	if err := persistence.Mutate(ctx, func(state *contracts.State) error {
		state.ThreadID = contracts.Some("executor-thread")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	receipt, err := value.Edit(ctx, "human", "  changed  ", true)
	if err != nil || !receipt.Resubmitted || receipt.Message.Text != "changed" || len(owner.Queue) != 1 || owner.Queue[0] != "human" {
		t.Fatal("resubmission changed queue identity")
	}
	message, _ := persistence.Message("human")
	if message.Status.Value != contracts.MessageStatus(contracts.TaskStatusQueued) || !message.TurnID.Null || !message.Submission.Null || persistence.Snapshot().ThreadID.Value != "executor-thread" {
		t.Fatal("edit changed persistent thread or invented confirmation")
	}
}

func TestQueuedWithdrawalAndConfirmedClearKeepDeduplicationTombstones(t *testing.T) {
	persistence, value, owner, _ := historyFixture(t)
	ctx := context.Background()
	addFixtureMessage(t, persistence, "queued", contracts.RoleUser)
	addFixtureMessage(t, persistence, "active", contracts.RoleUser)
	owner.Queue = []string{"queued"}
	owner.ActiveIDs = []string{"active"}
	receipt, err := value.Remove(ctx, "queued")
	if err != nil || !receipt.Withdrawn || len(owner.Queue) != 0 || !persistence.HasDeletedClientID("client-queued") {
		t.Fatal("queued withdrawal failed")
	}
	if _, err = value.Clear(ctx, true); err == nil {
		t.Fatal("clear removed active history")
	}
	owner.ActiveIDs = nil
	if _, err = value.Clear(ctx, false); err == nil {
		t.Fatal("clear bypassed explicit confirmation")
	}
	cleared, err := value.Clear(ctx, true)
	if err != nil || cleared.Count != 1 || len(persistence.Snapshot().Messages) != 0 || !persistence.HasDeletedClientID("client-active") {
		t.Fatal("confirmed clear lost deduplication tombstones")
	}
}

func TestNoopBookmarkSkipsWriteAndFailedEditCannotChangeQueue(t *testing.T) {
	writes := 0
	failWrite := false
	persistence, err := store.Open(t.TempDir(), store.Options{NewID: func() string {
		return fixtureConversation
	}, Write: func(ctx context.Context, path string, raw []byte, mode fs.FileMode) error {
		writes++
		if failWrite {
			return errors.New("fixture failure")
		}
		return files.WriteAtomic(ctx, path, raw, mode)
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	addFixtureMessage(t, persistence, "human", contracts.RoleUser)
	owner := Ownership{}
	applied := 0
	value := New(persistence, func(
		ctx context.Context,
		change func(Ownership) (QueueChange, error)) error {
		_, err := change(owner)
		if err == nil {
			applied++
		}
		return err
	})
	if _, err = value.SetMetadata(context.Background(), "human", bookmarkInput(json.RawMessage(`false`))); err != nil {
		t.Fatal(err)
	}
	before := writes
	failWrite = true
	if _, err = value.SetMetadata(context.Background(), "human", bookmarkInput(json.RawMessage(`false`))); err != nil || writes != before {
		t.Fatal("identical metadata attempted a write")
	}
	if _, err = value.Edit(context.Background(), "human", "unsaved", true); err == nil || applied != 0 {
		t.Fatal("failed persistence changed the queue")
	}
	message, _ := persistence.Message("human")
	if message.Text != "original" {
		t.Fatal("failed edit leaked into state")
	}
}
