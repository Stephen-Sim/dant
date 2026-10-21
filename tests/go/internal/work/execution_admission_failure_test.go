package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type rejectedExecutionEvents struct {
	Worker
	failure error
}

func (worker rejectedExecutionEvents) SubscribeEvents() (<-chan runtime.Event, func(), error) {
	return nil, nil, worker.failure
}

func TestMissingExecutionEventsCannotStartInitialOrContinuedWork(t *testing.T) {
	for _, continued := range []bool{false, true} {
		t.Run(map[bool]string{false: "initial input", true: "registered continuation"}[continued], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			failure := errors.New("isolated_event_subscription_failure")
			engine.worker = rejectedExecutionEvents{Worker: worker, failure: failure}
			if continued {
				workID, fromTurn := savedUnfinished(t, persistence)
				if _, err := engine.ContinueRegisteredWork(t.Context(), workID, ContinueOptions{ExpectedTurnID: fromTurn}); !errors.Is(err, failure) {
					t.Fatal("continuation without an event owner claimed admission", err)
				}
				state := persistence.Snapshot()
				if state.WorkTasks[0].TurnID != fromTurn || state.WorkTasks[0].Continuation.Dispatch != nil {
					t.Fatal("subscription rejection lost the known unsubmitted continuation")
				}
			} else {
				message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Authorized isolated request"})
				if err != nil || engine.Enqueue(t.Context(), message) != nil {
					t.Fatal("fixture admission failed", err)
				}
				waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && len(snapshot.Queue) == 0 })
				stored, err := persistence.Message(message.ID)
				if err != nil || stored.Text != message.Text || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || stored.UnknownOutcome {
					t.Fatal("subscription rejection invented a submitted task or lost input", err)
				}
			}
			if engine.Snapshot().Active != nil || engine.Snapshot().Executor.Paused {
				t.Fatal("known event subscription failure retained an unconfirmed external owner")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestAcknowledgedExecutionWhoseReceiptCannotBeSavedRetainsUnknownOwnership(t *testing.T) {
	for _, privateVoice := range []bool{false, true} {
		t.Run(map[bool]string{false: "chat acknowledgement", true: "voice work registration"}[privateVoice], func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				if privateVoice {
					return len(state.WorkTasks) != 0
				}
				return len(state.Messages) == 1 && state.Messages[0].Submission.Value == contracts.SubmissionStatusConfirmed
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			var message *contracts.ChatMessage
			var done chan error
			if privateVoice {
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "registration-failure-call", Provider: "api"}}
				done = make(chan error, 1)
				go func() {
					_, err := engine.RunVoiceTask(t.Context(), "Run only the entrusted task", ToolContext{CallID: "registration-failure-call", IsCurrent: func() bool { return true }})
					done <- err
				}()
			} else {
				var err error
				message, err = persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Exactly one entrusted action"})
				if err != nil || engine.Enqueue(t.Context(), message) != nil {
					t.Fatal("fixture admission failed", err)
				}
			}
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			start := nextRequest(t, worker, "turn/start")
			fault.armed.Store(true)
			start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("unpersisted-start-turn")})}}
			waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Executor.Paused })
			if fault.failures.Load() != 1 || engine.Snapshot().Active == nil {
				t.Fatal("unpersisted receipt retired the unresolved execution")
			}
			if _, valid := engine.ToolScope(); valid {
				t.Fatal("unpersisted acknowledgement retained tool authority")
			}
			if privateVoice {
				if len(persistence.Snapshot().Messages) != 0 || len(persistence.Snapshot().WorkTasks) != 0 {
					t.Fatal("failed private work registration leaked input or invented a saved record")
				}
			} else {
				stored, err := persistence.Message(message.ID)
				if err != nil || stored.Text != message.Text || stored.Submission.Value != contracts.SubmissionStatusSubmitting || stored.ExecutorConfirmedAt.Value != 0 {
					t.Fatal("failed acknowledgement save invented a durable executor receipt", err)
				}
			}
			engine.Wake()
			assertWorkerQuiet(t, worker)
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			if done != nil {
				if err := awaitWorkAction(t, done); !errors.Is(err, ErrClosed) {
					t.Fatal("shutdown converted an unresolved private task into success", err)
				}
			}
		})
	}
}

type changingContinuationAdmission struct {
	continuationCallBehavior
	before func()
}

func (calls *changingContinuationAdmission) CanContinueWhileIdle(ContinuationOwner) bool {
	calls.before()
	return true
}

func TestContinuationRechecksOwnershipAndCancellationBeforeClaimingSavedWork(t *testing.T) {
	for _, scenario := range []string{"paused during media admission", "cancelled before claim"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			engine.options.Calls = &changingContinuationAdmission{before: func() {
				if scenario == "cancelled before claim" {
					cancel()
					return
				}
				if err := engine.Pause(t.Context()); err != nil {
					t.Fatal(err)
				}
			}}
			_, err := engine.ContinueRegisteredWork(ctx, workID, ContinueOptions{ExpectedTurnID: fromTurn})
			if scenario == "cancelled before claim" && !errors.Is(err, context.Canceled) || scenario != "cancelled before claim" && !errors.Is(err, ErrBusy) {
				t.Fatal("changed admission was permitted to claim saved work", err)
			}
			state := persistence.Snapshot()
			continuation := state.WorkTasks[0].Continuation
			if state.WorkTasks[0].TurnID != fromTurn || continuation != nil && continuation.Dispatch != nil || engine.Snapshot().Active != nil {
				t.Fatal("rejected admission left a phantom continuation claim")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
