package store

import (
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestUnboundContinuationRetainsAcknowledgedIdentityWhenBindingCannotCommit(t *testing.T) {
	for _, status := range []contracts.WorkStatus{contracts.WorkStatusPaused, contracts.WorkStatusCancelled} {
		t.Run(string(status), func(t *testing.T) {
			clock := time.UnixMilli(10000)
			s, err := Open(t.TempDir(), Options{Now: func() time.Time { return clock }})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "remaining verification", Status: contracts.PlanStepStatusPending}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			record, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "old-turn", Source: "voice", Title: "Retained durable work", Plan: &plan})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.UpdateRegisteredWork(t.Context(), "old-turn", UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true}); err != nil {
				t.Fatal(err)
			}
			clock = time.UnixMilli(15000)
			if _, err := s.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{ExpectedTurnID: "old-turn", AttemptID: "attempt", RuntimeID: "vm:fixture", ThreadID: "thread"}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, "attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
				t.Fatal(err)
			}
			if _, err := s.FinishUnboundWorkContinuation(t.Context(), "missing", "attempt", "new-turn", status, 0); err == nil {
				t.Fatal("missing work acquired an acknowledged turn")
			}
			if _, err := s.FinishUnboundWorkContinuation(t.Context(), record.ID, "stale-attempt", "new-turn", status, 0); err == nil {
				t.Fatal("stale attempt changed current ownership")
			}
			finished, err := s.FinishUnboundWorkContinuation(t.Context(), record.ID, "attempt", "new-turn", status, 0)
			if err != nil || finished.TurnID != "new-turn" || len(finished.TurnIDs) != 2 || finished.Status != status || finished.PauseReason.Value != "continuation-save-failed" || finished.ExecutionEndedAt.Value != 15000 || finished.Continuation.Dispatch != nil || !finished.Continuation.NextAt.Null {
				t.Fatal("failed bind discarded acknowledged identity or made it replayable", finished, err)
			}
			if status == contracts.WorkStatusCancelled && finished.CancelledAt.Value != 15000 {
				t.Fatal("confirmed cancellation lost its terminal timestamp")
			}
			if _, err := s.FinishUnboundWorkContinuation(t.Context(), record.ID, "attempt", "new-turn", status, 0); err == nil {
				t.Fatal("acknowledged fallback was replayed")
			}
		})
	}
}

func TestPauseContinuingWorkOnlyChangesSafeUnfinishedRecords(t *testing.T) {
	s, _, _, _ := progressFixture(t)
	if _, err := s.PauseContinuingWork(t.Context(), -1, "valid-reason"); err == nil {
		t.Fatal("invalid pause time was accepted")
	}
	if _, err := s.PauseContinuingWork(t.Context(), 0, "bad reason"); err == nil {
		t.Fatal("unvalidated pause reason was accepted")
	}
	if ids, err := s.PauseContinuingWork(t.Context(), 0, ""); err != nil || len(ids) != 0 {
		t.Fatal("completed work was paused", ids, err)
	}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		record := &state.WorkTasks[0]
		record.Status = contracts.WorkStatusContinuing
		record.ExecutionEndedAt = contracts.Some(float64(1000))
		record.Plan.Steps[0].Status = contracts.PlanStepStatusPending
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ids, err := s.PauseContinuingWork(t.Context(), 0, "")
	if err != nil || len(ids) != 1 {
		t.Fatal("safe unfinished work did not pause", ids, err)
	}
	record := s.Snapshot().WorkTasks[0]
	if record.Status != contracts.WorkStatusPaused || record.PauseReason.Value != "user-paused" || record.Continuation == nil || !record.Continuation.NextAt.Null || record.Continuation.Dispatch != nil {
		t.Fatal("pause did not keep durable work fenced")
	}
}
