package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type stopConfirmationBoundary struct {
	Worker
	confirmed bool
	failure   error
	requests  int
}

func TestExplicitCancellationClearsTheSavedContinuationDeadlineWithoutRunningIt(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
		record := &state.WorkTasks[0]
		record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(engine.Timestamp() + 60_000), LastCheckpoint: workstate.Checkpoint(record.Plan)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if continuationDue(&state.WorkTasks[0]) != state.WorkTasks[0].Continuation.NextAt.Value {
		t.Fatal("saved continuation deadline was replaced by a guessed timer")
	}
	if _, err := engine.CancelProgress(t.Context(), ProgressTarget{ID: workID, Kind: "work", TurnID: contracts.Some(fromTurn), ConversationID: persistence.ConversationID()}, false); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	if state.WorkTasks[0].Status != contracts.WorkStatusCancelled || !state.WorkTasks[0].Continuation.NextAt.Null || state.WorkTasks[0].Continuation.Dispatch != nil || engine.Snapshot().Active != nil {
		t.Fatal("explicit cancellation left an automatically runnable continuation")
	}
	assertWorkerQuiet(t, worker)
}

func (worker *stopConfirmationBoundary) TerminateConfirmed(context.Context) (bool, error) {
	worker.requests++
	return worker.confirmed, worker.failure
}

func TestUnconfirmedProcessStopAndFailedSettlementRetainTheLastDurableOwner(t *testing.T) {
	for _, scenario := range []string{"process still running", "process query failed", "settlement save failed"} {
		t.Run(scenario, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				return len(state.Messages) == 1 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusPaused)
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			message, owner := beginBehaviorTurn(t, engine, persistence, worker, "stop-confirmation-owner")
			boundary := &stopConfirmationBoundary{Worker: worker, confirmed: scenario == "settlement save failed"}
			if scenario == "process query failed" {
				boundary.failure = errors.New("isolated_process_query_failure")
			}
			engine.worker = boundary
			if scenario == "settlement save failed" {
				fault.armed.Store(true)
			}
			err := engine.ConfirmStopped(t.Context())
			want := ErrUnknown
			if scenario == "settlement save failed" {
				want = store.ErrPersistence
			}
			if !errors.Is(err, want) || boundary.requests != 1 || engine.Snapshot().Active == nil {
				t.Fatal("unconfirmed or unsaved stop discarded its execution owner", err)
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Text != message.Text || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) {
				t.Fatal("failed stop settlement changed the last durable task state", err)
			}
			if scenario == "settlement save failed" && (owner.IsCurrent() || !engine.Snapshot().Executor.Paused || fault.failures.Load() != 1) {
				t.Fatal("failed stop settlement retained tools or lost its uncertainty")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestThreadLookupCannotCrossAnOwnedMaintenanceReservation(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	before := persistence.Revision()
	if err := engine.MaintenanceTransaction(t.Context(), func(ctx context.Context, current func() bool) error {
		if !current() {
			t.Fatal("fixture maintenance owner was not retained")
		}
		if _, err := engine.Thread(ctx); !errors.Is(err, ErrBusy) {
			t.Fatal("maintenance reservation admitted a new thread", err)
		}
		if _, err := engine.ConversationContext(ctx, false); !errors.Is(err, ErrBusy) {
			t.Fatal("conversation reference bypassed maintenance admission", err)
		}
		return nil
	}); err != nil || persistence.Revision() != before || engine.MaintenanceActive() {
		t.Fatal("read-only rejection changed data or retained maintenance ownership", err)
	}
	assertWorkerQuiet(t, worker)
}
