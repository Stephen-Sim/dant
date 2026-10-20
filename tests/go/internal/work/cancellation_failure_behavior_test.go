package work

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func detachedCancellationFixture(t *testing.T, persistence *store.Store) (*contracts.ChatMessage, *contracts.WorkRecord) {
	t.Helper()
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "retained authorized work", TurnID: contracts.Some("retained-cancellation-turn"),
		Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusConfirmed),
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "finish isolated verification", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: message.TurnID.Value, MessageID: message.ID, Source: "chat", Title: "retained authorized work", Plan: &plan,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		current, err := store.FindMessage(state, message.ID)
		if err != nil {
			return err
		}
		current.WorkID = record.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return message, record
}

func TestPausingDetachedProgressDoesNotPersistCancellationTimestamps(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, record := detachedCancellationFixture(t, persistence)
	if _, err := engine.CancelProgress(context.Background(), ProgressTarget{
		ID: record.ID, Kind: "work", TurnID: contracts.Some(record.TurnID), ConversationID: persistence.ConversationID(),
	}, true); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	paused, err := store.FindWork(&state, record.ID)
	if err != nil || paused.Status != contracts.WorkStatusPaused || paused.PauseReason.Value != "user-paused" || paused.CancelledAt.Present && !paused.CancelledAt.Null {
		t.Fatal("pausing detached work persisted an explicit cancellation", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.CancelledAt.Present && !stored.CancelledAt.Null {
		t.Fatal("pausing detached input persisted an explicit cancellation", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestDetachedCancellationFailureIsAtomicAndNeverChangesUnrelatedActiveOwnership(t *testing.T) {
	fault := &workPersistenceFault{}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	message, record := detachedCancellationFixture(t, persistence)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "unrelated-active-cancellation-turn")
	fault.match = func(state contracts.State) bool {
		current, err := store.FindMessage(&state, message.ID)
		return err == nil && current.Status.Value == contracts.MessageStatus(contracts.TaskStatusCancelled)
	}
	fault.armed.Store(true)
	if _, err := engine.CancelProgress(context.Background(), ProgressTarget{
		ID: record.ID, Kind: "work", TurnID: contracts.Some(record.TurnID),
	}, false); err == nil {
		t.Fatal("failed persistence returned a cancellation receipt")
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.CancelledAt.Present {
		t.Fatal("failed detached cancellation partly changed durable input", err)
	}
	if !engine.Current(owner) || fault.failures.Load() != 1 {
		t.Fatal("failed detached cancellation changed an unrelated active owner")
	}
	assertWorkerQuiet(t, worker)
}

func TestCancellingQueuedRegisteredWorkWithdrawsOnlyItsOwnedInputs(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, record := detachedCancellationFixture(t, persistence)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "unrelated-queued-cancellation-turn")
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	unrelated, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "keep this separately admitted work"})
	if err != nil || engine.Enqueue(context.Background(), unrelated) != nil {
		t.Fatal("could not admit unrelated queued input", err)
	}
	if _, err := engine.CancelProgress(context.Background(), ProgressTarget{
		ID: record.ID, Kind: "work", TurnID: contracts.Some(record.TurnID), ConversationID: persistence.ConversationID(),
	}, false); err != nil {
		t.Fatal(err)
	}
	if queue := engine.Snapshot().Queue; len(queue) != 1 || queue[0] != unrelated.ID || !engine.Current(owner) {
		t.Fatal("registered cancellation retained cancelled input or removed another task's ownership")
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	start := nextRequest(t, worker, "turn/start")
	if !bytes.Contains(start.params["input"], []byte(unrelated.Text)) || bytes.Contains(start.params["input"], []byte(message.Text)) {
		t.Fatal("the cancelled registered input reached a new executor turn")
	}
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("remaining-queued-turn")})}}
	waitToolScope(t, engine, "remaining-queued-turn")
}

func TestCancellationBeforeTurnSubmissionUsesTheCapturedActiveNullIdentity(t *testing.T) {
	for _, pauseOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "pause"}[pauseOnly], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "preparing isolated work"})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("could not admit isolated preparation", err)
			}
			thread := nextRequest(t, worker, "thread/start")
			if _, err := engine.CancelProgress(context.Background(), ProgressTarget{
				ID: "current", Kind: "active", TurnID: contracts.Null[string](), CallID: contracts.Null[string](), ConversationID: persistence.ConversationID(),
			}, pauseOnly); err != nil {
				t.Fatal(err)
			}
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.TurnID.Value != "" || stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted {
				t.Fatalf("unsubmitted preparation acquired executor authority: submission=%+v turn=%+v unknown=%v error=%v", stored.Submission, stored.TurnID, stored.UnknownOutcome, err)
			}
			if pauseOnly && stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || !pauseOnly && stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusCancelled) {
				t.Fatal("preparation cancellation confused pause with cancellation")
			}
			assertWorkerQuiet(t, worker)
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			directory := persistence.Directory()
			persistence.Close()
			reopened, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			retained, err := reopened.Message(message.ID)
			if err != nil || retained.Status.Value != stored.Status.Value || retained.Submission.Value != contracts.SubmissionStatusNotSubmitted || retained.TurnID.Value != "" || retained.UnknownOutcome || retained.ExecutorConfirmedAt.Present && !retained.ExecutorConfirmedAt.Null {
				t.Fatalf("reopening changed the exact known-unsubmitted cancellation tuple: status=%+v prior=%+v submission=%+v turn=%+v unknown=%v confirmed=%+v error=%v", retained.Status, stored.Status, retained.Submission, retained.TurnID, retained.UnknownOutcome, retained.ExecutorConfirmedAt, err)
			}
		})
	}
}

func TestCancellingAnAlreadyDispatchedStartNeverConvertsItsLateOutcomeToUnsubmitted(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(map[bool]string{false: "late-acknowledgement", true: "unknown-sent"}[uncertain], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "already dispatched isolated action"})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("could not admit isolated action", err)
			}
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			start := nextRequest(t, worker, "turn/start")
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := engine.CancelProgress(ctx, ProgressTarget{
				ID: "current", Kind: "active", TurnID: contracts.Null[string](), ConversationID: persistence.ConversationID(),
			}, false); !errors.Is(err, ErrUnknown) {
				t.Fatal("missing stop proof became a confirmed cancellation", err)
			}
			if uncertain {
				start.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
				waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
			} else {
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("late-cancelled-start-turn")})}}
				waitSnapshot(t, engine, func(snapshot Snapshot) bool {
					stored, err := persistence.Message(message.ID)
					return err == nil && stored.Submission.Value == contracts.SubmissionStatusConfirmed && snapshot.Active != nil && snapshot.Active.TurnID.Value == "late-cancelled-start-turn"
				})
				if _, current := engine.ToolScope(); current {
					t.Fatal("late acknowledged stopped owner retained tools")
				}
				if err := engine.Handle(context.Background(), terminal("late-cancelled-start-turn", "interrupted")); err != nil {
					t.Fatal(err)
				}
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Submission.Value == contracts.SubmissionStatusNotSubmitted || stored.UnknownOutcome != uncertain {
				t.Fatal("a dispatched start was made safe to repeat", err)
			}
			assertWorkerQuiet(t, worker)
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			directory := persistence.Directory()
			persistence.Close()
			reopened, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			retained, err := reopened.Message(message.ID)
			if err != nil || retained.Submission != stored.Submission || retained.UnknownOutcome != stored.UnknownOutcome || retained.TurnID != stored.TurnID {
				t.Fatal("reopening erased the dispatched action's exact outcome and owner", err)
			}
		})
	}
}

func TestCancellationRejectsMissingRolesInvalidIdentitiesAndUnconfirmedWork(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, record := detachedCancellationFixture(t, persistence)
	assistant, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "isolated output"})
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []ProgressTarget{
		{ID: assistant.ID, Kind: "task", TurnID: contracts.Null[string]()},
		{ID: "missing", Kind: "task", TurnID: contracts.Null[string]()},
		{ID: "missing", Kind: "work", TurnID: contracts.Null[string]()},
		{ID: message.ID, Kind: "task", TurnID: contracts.Null[string]()},
		{ID: message.ID, Kind: "task", TurnID: contracts.Some("bad\nidentity")},
		{ID: message.ID, Kind: "task", TurnID: message.TurnID, CallID: contracts.Some("bad\nidentity")},
		{ID: "missing", Kind: "active", TurnID: contracts.Some("absent-turn")},
	} {
		if _, err := engine.CancelProgress(context.Background(), target, false); err == nil {
			t.Fatal("invalid or unowned progress reached a cancellation commit")
		}
	}
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		current, err := store.FindWork(state, record.ID)
		if err != nil {
			return err
		}
		current.Status = contracts.WorkStatusUnknown
		current.UnknownOutcome = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.CancelProgress(context.Background(), ProgressTarget{ID: record.ID, Kind: "work", TurnID: message.TurnID}, false); !errors.Is(err, ErrUnknown) {
		t.Fatal("unconfirmed durable work was treated as safe to cancel", err)
	}
	state := persistence.Snapshot()
	retained, err := store.FindWork(&state, record.ID)
	if err != nil || retained.Status != contracts.WorkStatusUnknown || !retained.UnknownOutcome || retained.CancelledAt.Present {
		t.Fatal("rejected cancellation erased persisted uncertainty", err)
	}
	assertWorkerQuiet(t, worker)
}
