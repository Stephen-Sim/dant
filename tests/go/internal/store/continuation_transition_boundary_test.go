package store

import (
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func continuationTransitionFixture(t *testing.T) (*Store, *contracts.WorkRecord) {
	t.Helper()
	s, err := Open(t.TempDir(), Options{Now: func() time.Time { return time.UnixMilli(20000) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)

	plan := &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Synthetic remaining verification", Status: contracts.PlanStepStatusPending}}}
	record, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "retained-previous-turn", Source: "chat", Title: "Synthetic retained work", Plan: plan})
	if err != nil {
		t.Fatal(err)
	}
	record, err = s.UpdateRegisteredWork(t.Context(), record.TurnID, UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true, At: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return s, record
}

func claimTransitionFixture(t *testing.T, s *Store, record *contracts.WorkRecord) *contracts.WorkRecord {
	t.Helper()
	claimed, err := s.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: "transition-attempt", RuntimeID: "vm:isolated", ThreadID: "isolated-thread"})
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func TestClaimedContinuationCanPauseOrCancelBeforeAnyExternalSubmission(t *testing.T) {
	for _, status := range []contracts.WorkStatus{contracts.WorkStatusPaused, contracts.WorkStatusCancelled, ""} {
		t.Run(string(status), func(t *testing.T) {
			s, record := continuationTransitionFixture(t)
			claimed := claimTransitionFixture(t, s, record)
			settled, err := s.SettleWorkContinuation(t.Context(), record.ID, claimed.Continuation.Dispatch.ID, SettleContinuationOptions{Status: status})
			if err != nil || settled.TurnID != record.TurnID || settled.Continuation.Dispatch != nil {
				t.Fatal("unsubmitted claim did not retain its original turn", err)
			}
			if status == contracts.WorkStatusPaused {
				if settled.Status != status || !settled.Continuation.NextAt.Null || settled.PauseReason.Value != "continuation-paused" {
					t.Fatal("paused claim retained automatic execution eligibility")
				}
			} else if status == contracts.WorkStatusCancelled {
				if settled.Status != status || settled.CancelledAt.Value != 20000 || settled.ExecutionEndedAt.Value != 20000 || !settled.Continuation.NextAt.Null {
					t.Fatal("cancelled claim lost its terminal time or retained a due retry")
				}
			} else if settled.Status != contracts.WorkStatusContinuing || settled.Continuation.NextAt.Value <= 20000 {
				t.Fatal("known unsubmitted default failure did not retain its bounded retry policy")
			}
		})
	}
}

func TestContinuationPhaseAndSettlementRejectForeignOrInvalidTransitions(t *testing.T) {
	s, record := continuationTransitionFixture(t)
	claimed := claimTransitionFixture(t, s, record)
	attempt := claimed.Continuation.Dispatch.ID
	before := s.Revision()

	if _, err := s.ClaimWorkContinuation(t.Context(), "missing-work", ClaimContinuationOptions{}); err == nil {
		t.Fatal("missing work acquired a continuation claim")
	}
	if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, "foreign-attempt", contracts.ContinuationDispatchPhaseSubmitting); err == nil {
		t.Fatal("foreign claim advanced continuation dispatch")
	}
	if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, attempt, contracts.ContinuationDispatchPhaseAcknowledged); err == nil {
		t.Fatal("unsubmitted claim became acknowledged without an executor turn")
	}
	if _, err := s.BindWorkContinuation(t.Context(), record.ID, "foreign-attempt", "new-turn"); err == nil {
		t.Fatal("foreign claim bound an acknowledged turn")
	}
	for _, input := range []SettleContinuationOptions{{At: -1}, {Status: contracts.WorkStatusCompleted}} {
		if _, err := s.SettleWorkContinuation(t.Context(), record.ID, attempt, input); err == nil {
			t.Fatal("invalid settlement supplied success or an invented timestamp")
		}
	}
	if s.Revision() != before {
		t.Fatal("rejected continuation transitions changed durable state")
	}

	unknown, err := s.SetWorkContinuationPhase(t.Context(), record.ID, attempt, contracts.ContinuationDispatchPhaseUnknown)
	if err != nil || unknown.Status != contracts.WorkStatusUnknown || unknown.Continuation.Dispatch.ID != attempt {
		t.Fatal("unknown dispatch lost its exact retained claim", err)
	}
}

func TestHumanReplyResetsContinuationBackoffAndKeepsItsAttemptHistory(t *testing.T) {
	s, record := continuationTransitionFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		current, err := FindWork(state, record.ID)
		if err != nil {
			return err
		}
		current.Status = contracts.WorkStatusPaused
		current.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), Attempts: 8, NoProgressCount: 3, LastCheckpoint: workstate.Checkpoint(current.Plan)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	claimed, err := s.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: "human-reply-attempt", RuntimeID: "vm:isolated", ThreadID: "isolated-thread", HumanReply: true})
	if err != nil || claimed.Status != contracts.WorkStatusContinuing || claimed.Continuation.Attempts != 9 || claimed.Continuation.NoProgressCount != 0 || claimed.Continuation.NextAt.Value != 20000 {
		t.Fatal("explicit human reply lost prior attempts or inherited automatic backoff", err)
	}
}

func TestRepeatedUnproductiveAcknowledgedTurnsPauseAutomaticContinuation(t *testing.T) {
	s, record := continuationTransitionFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		current, err := FindWork(state, record.ID)
		if err != nil {
			return err
		}
		current.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(float64(1000)), Attempts: 2, NoProgressCount: 2, LastCheckpoint: workstate.Checkpoint(current.Plan)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	claimTransitionFixture(t, s, record)
	if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, "transition-attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindWorkContinuation(t.Context(), record.ID, "transition-attempt", "observed-unproductive-turn"); err != nil {
		t.Fatal(err)
	}
	ended, err := s.UpdateRegisteredWork(t.Context(), "observed-unproductive-turn", UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true})
	if err != nil || ended.Status != contracts.WorkStatusPaused || ended.PauseReason.Value != "automatic-no-progress" || ended.Continuation.NoProgressCount != 3 || !ended.Continuation.NextAt.Null || ended.Continuation.Dispatch != nil {
		t.Fatal("repeated unproductive turns remained eligible for automatic execution", err)
	}
}
