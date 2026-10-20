package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func quietCompletedOutput(owner ToolContext, id, text, phase string) runtime.Event {
	return runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{
		"id": raw(id), "type": raw("agentMessage"), "text": raw(text), "phase": raw(phase),
	})}, owner.TurnID)
}

func TestQuietPublicationPrefersTheFinalAnswerAndIncludesOnlyVerifiedBufferedResults(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "quiet-final-answer-turn")
	owner := waitToolScope(t, engine, "quiet-final-answer-turn")
	if _, err := engine.DeliverText(context.Background(), "unverified interim narration", owner); err != nil {
		t.Fatal(err)
	}
	arguments := behaviorPlan("verified entrusted task", contracts.PlanStepStatusCompleted)
	arguments["workId"] = raw(workID)
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DeliverText(context.Background(), "verified buffered result", owner); err != nil {
		t.Fatal(err)
	}
	for _, event := range []runtime.Event{
		quietCompletedOutput(owner, "analysis-output", "intermediate analysis", "commentary"),
		quietCompletedOutput(owner, "final-output", "actual final answer", "final_answer"),
		quietCompletedOutput(owner, "late-commentary", "after-final commentary", "commentary"),
		quietCompletedOutput(owner, "blank-output", " \t\n", "commentary"),
	} {
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
	}
	if len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("automatic work published before its final verified terminal")
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Text != "verified buffered result\n\nactual final answer" || state.Messages[0].WorkID != workID {
		t.Fatal("publication chose narration over the final answer or included unverified buffered text")
	}
}

func TestQuietWaitingPlanPublishesOneActionableQuestionAndLeavesDurableWorkWaiting(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "quiet-waiting-turn")
	owner := waitToolScope(t, engine, "quiet-waiting-turn")
	arguments := behaviorPlan("work needs human input", contracts.PlanStepStatusPending)
	arguments["workId"], arguments["status"] = raw(workID), raw(contracts.WorkStatusWaitingUser)
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DeliverText(context.Background(), "Which isolated output should I keep?", owner); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), quietCompletedOutput(owner, "waiting-answer", "Which isolated output should I keep?", "final_answer")); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Text != "Which isolated output should I keep?" || state.WorkTasks[0].Status != contracts.WorkStatusWaitingUser || state.WorkTasks[0].Continuation.Dispatch != nil {
		t.Fatal("ended input request was treated as completed work or duplicated its human question")
	}
	if _, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: owner.TurnID}); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("human-input blocker became an automatic continuation", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestQuietFailurePublishesOnlyAFixedFailureAndDoesNotRepeatNarration(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		state.Settings.Language = "en"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "quiet-failure-turn")
	owner := waitToolScope(t, engine, "quiet-failure-turn")
	if err := engine.Handle(context.Background(), quietCompletedOutput(owner, "failure-narration", "fixture-private-provider-error", "final_answer")); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "failed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Text != "The task stopped before completion." || strings.Contains(state.Messages[0].Text, "fixture-private") || state.WorkTasks[0].Status != contracts.WorkStatusFailed {
		t.Fatal("quiet failure exposed provider output or lost its durable failed state")
	}
	assertWorkerQuiet(t, worker)
}

func TestQuietOutputBudgetRetainsTheLatestResultWithinItsFixedUTF16Bound(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "quiet-budget-turn")
	owner := waitToolScope(t, engine, "quiet-budget-turn")
	arguments := behaviorPlan("verified output budget", contracts.PlanStepStatusCompleted)
	arguments["workId"] = raw(workID)
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{strings.Repeat("a", 60000), strings.Repeat("b", 60000), strings.Repeat("c", 60000)} {
		if _, err := engine.DeliverText(context.Background(), text, owner); err != nil {
			t.Fatal(err)
		}
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || contracts.UTF16Length(state.Messages[0].Text) > runtimeOutputCharacters || state.Messages[0].Text != strings.Repeat("c", 60000) {
		t.Fatal("quiet publication exceeded its budget or retained an evicted stale result")
	}
}
