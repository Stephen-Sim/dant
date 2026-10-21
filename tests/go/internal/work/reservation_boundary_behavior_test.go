package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type unfinishedMediaCalls struct{ *admissionCalls }

func (*unfinishedMediaCalls) PendingWork() bool { return true }

func TestIdleTransactionsRejectCancelledMissingAndBusyOperations(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := engine.ConnectionTransaction(t.Context(), true, nil); !errors.Is(err, ErrBusy) {
		t.Fatal("missing connection operation acquired admission", err)
	}
	if err := engine.MaintenanceTransaction(t.Context(), nil); !errors.Is(err, ErrBusy) {
		t.Fatal("missing maintenance operation acquired admission", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	operation := func(context.Context) error { t.Error("rejected connection operation ran"); return nil }
	capture := func(context.Context, func() bool) error { t.Error("rejected backup operation ran"); return nil }
	if err := engine.ConnectionTransaction(cancelled, true, operation); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled connection acquired admission", err)
	}
	if err := engine.MaintenanceTransaction(cancelled, capture); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled backup acquired admission", err)
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "idle-operation-owner-turn")
	if err := engine.ConnectionTransaction(t.Context(), true, operation); !errors.Is(err, ErrBusy) {
		t.Fatal("connection replaced an active turn", err)
	}
	if err := engine.MaintenanceTransaction(t.Context(), capture); !errors.Is(err, ErrBusy) {
		t.Fatal("backup crossed an active execution", err)
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := engine.ConnectionTransaction(t.Context(), false, func(ctx context.Context) error {
		return persistence.Mutate(ctx, func(state *contracts.State) error {
			state.ConversationID = "2a802fe0-7afb-4489-b899-3f57e310de2c"
			return nil
		})
	}); !errors.Is(err, ErrStaleOwner) || engine.MaintenanceActive() {
		t.Fatal("connection result adopted a replacement conversation", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestCallStartReservationsCaptureTheActiveTurnAndRejectChangedEpoch(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := engine.ReserveCallStart(cancelled, "cancelled", "api"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled call reserved execution authority", err)
	}
	for _, fixture := range [][2]string{{"", "api"}, {"call", "foreign"}} {
		if _, err := engine.ReserveCallStart(t.Context(), fixture[0], fixture[1]); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("invalid media owner reserved admission", err)
		}
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "reservation-capture-turn")
	reservation, err := engine.ReserveCallStart(t.Context(), "reserved-native-call", "subscription")
	if err != nil || reservation.ActiveTurnID != owner.TurnID || reservation.ActiveWorkID != owner.WorkID || !engine.CallStartCurrent(reservation) {
		t.Fatal("call reservation did not capture the current execution", err)
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	engine.epoch++
	engine.mu.Unlock()
	if engine.CallStartCurrent(reservation) {
		t.Fatal("native call adopted a changed engine epoch")
	}
	engine.ReleaseCallStart(reservation)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "already-connected-call", Provider: "api"}}
	if _, err := engine.ReserveCallStart(t.Context(), "new-call", "api"); !errors.Is(err, ErrBusy) {
		t.Fatal("another call reserved already occupied media", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestContinuationAvailabilityHonorsQueuedAndUnsettledOwners(t *testing.T) {
	for _, scenario := range []string{"idle", "queued", "followup", "provider request", "offline", "native reservation", "unknown submission", "unfinished media"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			switch scenario {
			case "queued":
				engine.mu.Lock()
				engine.queue = []string{"retained-queue-owner"}
				engine.mu.Unlock()
			case "followup":
				engine.mu.Lock()
				engine.pendingFollowups["retained-followup-owner"] = true
				engine.mu.Unlock()
			case "provider request":
				engine.mu.Lock()
				engine.pendingRequests["retained-provider-request"] = runtimeEvent("item/tool/requestUserInput", contracts.RawObject{}, "retained-turn")
				engine.mu.Unlock()
			case "offline":
				engine.worker = unavailableVoiceWorker{fakeWorker: worker}
			case "native reservation":
				if _, err := engine.ReserveCallStart(t.Context(), "reserved-native", "subscription"); err != nil {
					t.Fatal(err)
				}
			case "unknown submission":
				if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Retained uncertain request", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusUnknown)}); err != nil {
					t.Fatal(err)
				}
			case "unfinished media":
				engine.options.Calls = &unfinishedMediaCalls{admissionCalls: &admissionCalls{}}
			}
			if available := engine.CanContinueRegisteredWork(); available != (scenario == "idle") {
				t.Fatal("continuation availability ignored another unsettled owner")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestUnconfirmedExecutorStopRetainsUnfinishedWorkAndPreservesTerminalRecords(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	for _, status := range []contracts.WorkStatus{contracts.WorkStatusRunning, contracts.WorkStatusCompleted, contracts.WorkStatusCancelled} {
		record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "shutdown-" + string(status), Source: "chat", Title: "Synthetic shutdown record", Observed: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
			current, err := store.FindWork(state, record.ID)
			if err == nil {
				current.Status = status
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := engine.FenceUnconfirmedStop(t.Context()); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if !engine.UnconfirmedStop() || state.WorkTasks[0].Status != contracts.WorkStatusUnknown || !state.WorkTasks[0].UnknownOutcome || state.WorkTasks[1].Status != contracts.WorkStatusCompleted || state.WorkTasks[1].UnknownOutcome || state.WorkTasks[2].Status != contracts.WorkStatusCancelled {
		t.Fatal("unconfirmed shutdown lost unfinished work or reopened terminal work")
	}
	assertWorkerQuiet(t, worker)
}
