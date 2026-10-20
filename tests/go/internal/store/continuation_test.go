package store

import (
	"context"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
	"testing"
	"time"
)

func TestDurableContinuationRequiresClaimSubmitExactAcknowledgementAndTerminalEvent(t *testing.T) {
	ctx := context.Background()
	clock := time.UnixMilli(10000)
	store, err := Open(t.TempDir(), Options{Now: func() time.Time {
		return clock
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	plan, _ := workstate.PublicPlan([]contracts.PlanStep{{Step: "verify result", Status: contracts.PlanStepStatusPending}}, nil)
	record, err := store.RegisterWork(ctx, RegisterWorkOptions{TurnID: "turn-one", Source: "chat", Title: "real work", Plan: &plan})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateRegisteredWork(ctx, "turn-one", UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true})
	if err != nil {
		t.Fatal(err)
	}
	clock = time.UnixMilli(15000)
	claim, err := store.ClaimWorkContinuation(ctx, record.ID, ClaimContinuationOptions{ExpectedTurnID: "turn-one", AttemptID: "attempt", RuntimeID: "vm:one", ThreadID: "thread"})
	if err != nil {
		t.Fatal(err)
	}
	if claim.Continuation.Attempts != 1 {
		t.Fatal("claim not durable")
	}
	if _, err = store.BindWorkContinuation(ctx, record.ID, "attempt", "turn-two"); err == nil {
		t.Fatal("unsubmitted claim was acknowledged")
	}
	if _, err = store.SetWorkContinuationPhase(ctx, record.ID, "attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		t.Fatal(err)
	}
	if _, err = store.ClaimWorkContinuation(ctx, record.ID, ClaimContinuationOptions{ExpectedTurnID: "turn-one", AttemptID: "another", RuntimeID: "vm:one", ThreadID: "thread"}); err == nil {
		t.Fatal("submitting work replayed")
	}
	bound, err := store.BindWorkContinuation(ctx, record.ID, "attempt", "turn-two")
	if err != nil {
		t.Fatal(err)
	}
	if bound.TurnID != "turn-two" || len(bound.TurnIDs) != 2 {
		t.Fatal("acknowledged turn identity lost")
	}
	if _, err = store.UpdateRegisteredWork(ctx, "turn-one", UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusCompleted), ExecutionEnded: true}); err != nil {
		t.Fatal(err)
	}
	if store.Snapshot().WorkTasks[0].Status != contracts.WorkStatusRunning {
		t.Fatal("old terminal event changed new owner")
	}
	clock = time.UnixMilli(17000)
	ended, err := store.UpdateRegisteredWork(ctx, "turn-two", UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true})
	if err != nil {
		t.Fatal(err)
	}
	if ended.Continuation.Dispatch != nil || ended.Continuation.NoProgressCount != 1 || ended.Continuation.NextAt.Value != 47000 {
		t.Fatal("terminal checkpoint/backoff was not durably reconciled")
	}
}
