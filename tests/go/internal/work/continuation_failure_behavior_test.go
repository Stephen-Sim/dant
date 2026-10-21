package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func beginContinuationBehavior(t *testing.T, engine *Engine, worker *fakeWorker, workID, fromTurn string) chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: fromTurn})
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	return done
}

func continuationBehaviorThread(fromTurn string) contracts.RawObject {
	return contracts.RawObject{
		"id": raw("thread-fixture"), "status": raw(contracts.RawObject{"type": raw("idle")}),
		"turns": raw([]contracts.RawObject{{"id": raw(fromTurn), "status": raw("completed")}}),
	}
}

func TestContinuationReadFailuresNeverDispatchANewTurnAndSettleTheKnownUnsubmittedClaim(t *testing.T) {
	for _, scenario := range []string{
		"read-error", "malformed-thread", "wrong-thread", "malformed-status", "malformed-turns",
		"invalid-turn-id", "duplicate-turn-id", "nonterminal-turn", "missing-original-turn",
	} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
			read := nextRequest(t, worker, "thread/read")
			thread := continuationBehaviorThread(fromTurn)
			response := fakeResponse{value: contracts.RawObject{"thread": raw(thread)}}
			switch scenario {
			case "read-error":
				response.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
			case "malformed-thread":
				response.value["thread"] = raw([]string{})
			case "wrong-thread":
				thread["id"] = raw("foreign-thread")
			case "malformed-status":
				thread["status"] = raw("idle")
			case "malformed-turns":
				thread["turns"] = raw(true)
			case "invalid-turn-id":
				thread["turns"] = raw([]contracts.RawObject{{"id": raw(""), "status": raw("completed")}})
			case "duplicate-turn-id":
				turn := contracts.RawObject{"id": raw(fromTurn), "status": raw("completed")}
				thread["turns"] = raw([]contracts.RawObject{turn, turn})
			case "nonterminal-turn":
				thread["turns"] = raw([]contracts.RawObject{{"id": raw(fromTurn), "status": raw("inProgress")}})
			case "missing-original-turn":
				thread["turns"] = raw([]contracts.RawObject{})
			}
			if scenario != "malformed-thread" {
				response.value["thread"] = raw(thread)
			}
			read.result <- response
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("invalid canonical thread became permission for another turn")
			}
			state := persistence.Snapshot()
			record, err := store.FindWork(&state, workID)
			if err != nil || record.Status != contracts.WorkStatusContinuing || record.TurnID != fromTurn || record.Continuation == nil || record.Continuation.Dispatch != nil || record.Continuation.NextAt.Value <= 0 || engine.Snapshot().Active != nil || engine.Snapshot().Executor.Paused {
				t.Fatal("known unsubmitted continuation lost its identity or retained a false uncertain dispatch", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestContinuationStartFailuresPreserveTheirKnownOrUnknownExternalOutcome(t *testing.T) {
	for _, scenario := range []string{"known-rejection", "unknown-rejection", "malformed-acknowledgement", "reused-turn"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
			read := nextRequest(t, worker, "thread/read")
			read.result <- fakeResponse{value: contracts.RawObject{"thread": raw(continuationBehaviorThread(fromTurn))}}
			start := nextRequest(t, worker, "turn/start")
			known := scenario == "known-rejection"
			response := fakeResponse{}
			switch scenario {
			case "known-rejection", "unknown-rejection":
				response.err = &runtime.OperationError{Cause: runtime.ErrRequestFailed, UnknownOutcome: !known}
			case "malformed-acknowledgement":
				response.value = contracts.RawObject{"turn": raw(contracts.RawObject{})}
			case "reused-turn":
				response.value = contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(fromTurn)})}
			}
			start.result <- response
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("unconfirmed continuation start returned a confirmed result")
			}
			state := persistence.Snapshot()
			record, err := store.FindWork(&state, workID)
			if err != nil || record.TurnID != fromTurn || engine.Snapshot().Active != nil || engine.Snapshot().Executor.Paused == known {
				t.Fatal("continuation failure changed its previous turn identity or pause fence", err)
			}
			if known {
				if record.Status != contracts.WorkStatusContinuing || record.Continuation.Dispatch != nil || record.Continuation.NextAt.Value <= 0 {
					t.Fatal("known rejection retained an external-action uncertainty")
				}
			} else {
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch == nil || record.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown {
					t.Fatal("unknown continuation was incorrectly classified as safe to replay")
				}
				if _, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: fromTurn}); !errors.Is(err, ErrBusy) {
					t.Fatal("unknown start could be automatically resubmitted", err)
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

type continuationCallBehavior struct {
	admissionCalls
	allowed                              bool
	beginErr, replayErr, confirmationErr error
	conflict                             bool
	begun, replayed, confirmed, finished int
}

func (calls *continuationCallBehavior) CanContinueWhileIdle(ContinuationOwner) bool {
	return calls.allowed
}

func (calls *continuationCallBehavior) BeginContinuationAdmission(owner ContinuationOwner) (ContinuationAdmission, error) {
	calls.begun++
	return ContinuationAdmission{Owner: owner, CallID: "native-call"}, calls.beginErr
}

func (calls *continuationCallBehavior) ConfirmContinuationAdmission(ContinuationAdmission, string) error {
	calls.confirmed++
	return calls.confirmationErr
}

func (calls *continuationCallBehavior) ReplayContinuationEvents(_ context.Context, _ ContinuationAdmission, events []runtime.Event, _ string, _ bool) ([]runtime.Event, bool, error) {
	calls.replayed++
	return events, calls.conflict, calls.replayErr
}

func (calls *continuationCallBehavior) FinishContinuationAdmission(ContinuationAdmission) {
	calls.finished++
}

func TestNativeContinuationAdmissionHasOneOwnerAndFailsClosedAfterAnUncertainHandoff(t *testing.T) {
	for _, scenario := range []string{"not-idle", "begin-rejected", "replay-error", "replay-conflict", "confirmation-error", "accepted"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			calls := &continuationCallBehavior{allowed: scenario != "not-idle"}
			switch scenario {
			case "begin-rejected":
				calls.beginErr = ErrBusy
			case "replay-error":
				calls.replayErr = ErrUnknown
			case "replay-conflict":
				calls.conflict = true
			case "confirmation-error":
				calls.confirmationErr = ErrUnknown
			}
			engine.options.Calls = calls
			workID, fromTurn := savedUnfinished(t, persistence)
			if scenario == "not-idle" || scenario == "begin-rejected" {
				if _, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: fromTurn}); !errors.Is(err, ErrBusy) {
					t.Fatal("rejected native admission dispatched work", err)
				}
				assertWorkerQuiet(t, worker)
				return
			}
			done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
			read := nextRequest(t, worker, "thread/read")
			read.result <- fakeResponse{value: contracts.RawObject{"thread": raw(continuationBehaviorThread(fromTurn))}}
			start := nextRequest(t, worker, "turn/start")
			start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("native-continuation-turn")})}}
			err := awaitWorkAction(t, done)
			if scenario == "accepted" {
				if err != nil || calls.begun != 1 || calls.replayed != 1 || calls.confirmed != 1 || calls.finished != 0 {
					t.Fatal("accepted native admission did not retain one exact owner", err)
				}
				if err := engine.Handle(context.Background(), terminal("native-continuation-turn", "completed")); err != nil || calls.finished != 1 {
					t.Fatal("terminal native execution did not release its admission once", err)
				}
			} else {
				state := persistence.Snapshot()
				record, lookupErr := store.FindWork(&state, workID)
				if err == nil || lookupErr != nil || record.Status != contracts.WorkStatusUnknown || calls.finished != 1 || engine.Snapshot().Active != nil || !engine.Snapshot().Executor.Paused {
					t.Fatal("uncertain handoff lost its durable unknown fence or leaked admission", err, lookupErr)
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
