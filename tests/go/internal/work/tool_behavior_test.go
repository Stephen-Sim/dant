package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func behaviorPlan(title string, status contracts.PlanStepStatus) contracts.RawObject {
	return contracts.RawObject{"title": raw(title), "steps": raw([]contracts.PlanStep{{Step: "verify isolated result", Status: status}})}
}

func TestTaskToolsRetainWaitingPlansAndExposeOnlyPublicTaskSummaries(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-confidential", "[redacted]")
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "plan-tool-turn")
	arguments := behaviorPlan("fixture-confidential title", contracts.PlanStepStatusPending)
	arguments["status"] = raw(contracts.WorkStatusWaitingUser)
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err != nil {
		t.Fatal(err)
	}
	for _, status := range []contracts.PlanStepStatus{contracts.PlanStepStatusInProgress, contracts.PlanStepStatusCompleted} {
		if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("blocked overwrite", status), owner); err == nil {
			t.Fatal("plan tool bypassed the pending human blocker")
		}
	}
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("updated pending title", contracts.PlanStepStatusPending), owner); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.WorkTasks) != 1 || state.WorkTasks[0].Status != contracts.WorkStatusWaitingUser {
		t.Fatal("updating a waiting checklist lost its work identity or resumed execution")
	}
	if _, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "observed-other-turn", Source: "chat", Title: "fixture-confidential observed", Observed: true,
	}); err != nil {
		t.Fatal(err)
	}
	receipt, err := engine.Tool(context.Background(), "task_list", contracts.RawObject{}, owner)
	var listed struct{ Items []contracts.RawObject }
	if err != nil || json.Unmarshal(receipt, &listed) != nil || len(listed.Items) != 2 || strings.Contains(string(receipt), "fixture-confidential") || strings.Contains(string(receipt), "projectContext") || strings.Contains(string(receipt), "originalRequest") {
		t.Fatal("task listing exposed private context or omitted actual registered work", err)
	}
	if string(listed.Items[0]["steps"]) != `{"completed":0,"total":1}` || string(listed.Items[1]["steps"]) != "null" {
		t.Fatal("task summary invented a plan or lost its completed/total counts")
	}
	for _, name := range []string{"task_list", "chat_delivery_policy", "task_cancel"} {
		if _, err := engine.Tool(context.Background(), name, contracts.RawObject{"extra": raw(true)}, owner); err == nil {
			t.Fatal("tool accepted undeclared permission fields", name)
		}
	}
	if _, err := engine.Tool(context.Background(), "task_cancel", contracts.RawObject{"workId": raw("")}, owner); err == nil {
		t.Fatal("task cancellation accepted an empty work identity")
	}
	if _, err := engine.Tool(context.Background(), "task_plan", contracts.RawObject{}, owner); err == nil {
		t.Fatal("an empty plan replaced the actual checklist")
	}
	if _, err := engine.Tool(context.Background(), "fixture_unbound", contracts.RawObject{}, owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("an unbound tool gained an implicit executor", err)
	}
	for _, invalid := range []ToolContext{{}, {IsCurrent: func() bool { return false }}} {
		if _, err := engine.Tool(context.Background(), "task_list", nil, invalid); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("task tools accepted an owner without current authority", err)
		}
	}
	assertWorkerQuiet(t, worker)
}

func TestPlanToolCannotReopenEndedWorkOrReplaceAContinuationTask(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	ended, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "ended-prior-turn", Source: "chat", Title: "ended task", Observed: true, Status: contracts.WorkStatusCompleted,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(context.Background(), ended.TurnID, store.UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusCompleted), ExecutionEnded: true, At: engine.Timestamp(),
	}); err != nil {
		t.Fatal(err)
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "unrelated-plan-turn")
	arguments := behaviorPlan("unauthorized reopen", contracts.PlanStepStatusPending)
	arguments["workId"] = raw(ended.ID)
	var conflict *contracts.APIError
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); !errors.As(err, &conflict) || conflict.Code != "work_reply_required" {
		t.Fatal("a tool reopened ended work without a new human reply", err)
	}
	arguments["workId"] = raw("missing-work")
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err == nil {
		t.Fatal("a nonexistent work identity was silently replaced")
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}

	continuing, saved, continuingWorker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, saved)
	continueFixture(t, continuing, continuingWorker, workID, fromTurn, "bound-continuation-turn")
	current := waitToolScope(t, continuing, "bound-continuation-turn")
	response, err := continuing.Tool(context.Background(), "task_plan", behaviorPlan("new unrelated task", contracts.PlanStepStatusPending), current)
	var refused struct {
		Saved        bool
		Code         string
		ActiveWorkID string
	}
	if err != nil || json.Unmarshal(response, &refused) != nil || refused.Saved || refused.Code != "work_conflict" || refused.ActiveWorkID != workID {
		t.Fatal("continuation tool escaped its original task scope", err)
	}
	policy, err := continuing.Tool(context.Background(), "chat_delivery_policy", contracts.RawObject{}, current)
	var delivery struct{ Quiet, PendingPublication, Sent bool }
	if err != nil || json.Unmarshal(policy, &delivery) != nil || !delivery.Quiet || !delivery.PendingPublication || delivery.Sent {
		t.Fatal("automatic continuation was allowed to publish intermediate chatter", err)
	}
	if len(saved.Snapshot().WorkTasks) != 1 {
		t.Fatal("a refused continuation plan created a second work record")
	}
}

func TestTaskCancellationToolInterruptsItsExactActiveOwnerAndRetiresItsAuthority(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "cancel-tool-turn")
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("cancel actual work", contracts.PlanStepStatusInProgress), owner); err != nil {
		t.Fatal(err)
	}
	workID := persistence.Snapshot().WorkTasks[0].ID
	result, err := engine.Tool(context.Background(), "task_cancel", contracts.RawObject{"workId": raw(workID)}, owner)
	var requested struct {
		CancelRequested bool
		WorkID, TurnID  string
	}
	if err != nil || json.Unmarshal(result, &requested) != nil || !requested.CancelRequested || requested.WorkID != workID || requested.TurnID != owner.TurnID {
		t.Fatal("task cancellation lost its captured owner", err)
	}
	interrupt := nextRequest(t, worker, "turn/interrupt")
	if eventString(interrupt.params, "turnId") != owner.TurnID || eventString(interrupt.params, "threadId") != owner.ThreadID {
		t.Fatal("tool cancellation interrupted an unrelated execution")
	}
	if _, err := engine.RequestWorkCancellation(context.Background(), workID, owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("stopping owner retained authority to dispatch a second cancellation", err)
	}
	interrupt.result <- fakeResponse{value: contracts.RawObject{}}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "interrupted")); err != nil {
		t.Fatal(err)
	}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	stored, err := persistence.Message(message.ID)
	state := persistence.Snapshot()
	record, recordErr := store.FindWork(&state, workID)
	if err != nil || recordErr != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusCancelled) || record.Status != contracts.WorkStatusCancelled {
		t.Fatal("confirmed interruption did not settle the exact cancelled task", err, recordErr)
	}
	assertWorkerQuiet(t, worker)
}

func TestTaskCancellationToolCanCancelDetachedWorkWithoutReplayingItsOldTurn(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	detached, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "detached-turn", Source: "chat", Title: "detached task", Observed: true, Status: contracts.WorkStatusRunning,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "other-current-turn")
	if _, err := engine.Tool(context.Background(), "task_cancel", contracts.RawObject{"workId": raw(detached.ID)}, owner); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	record, err := store.FindWork(&state, detached.ID)
	if err != nil || record.Status != contracts.WorkStatusCancelled || engine.Snapshot().Active.TurnID.Value != owner.TurnID {
		t.Fatal("detached cancellation changed the unrelated active owner", err)
	}
	if _, err := engine.Tool(context.Background(), "task_cancel", contracts.RawObject{"workId": raw(detached.ID)}, owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("ended work remained cancellable as a live execution", err)
	}
	if _, err := engine.Tool(context.Background(), "task_cancel", contracts.RawObject{"workId": raw("missing-work")}, owner); err == nil {
		t.Fatal("cancelling a nonexistent task fabricated a result")
	}
	assertWorkerQuiet(t, worker)
	if _, err := engine.RequestWorkCancellation(context.Background(), detached.ID, ToolContext{IsCurrent: func() bool { return true }}); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("ended detached work was treated as eligible for replay", err)
	}
}
