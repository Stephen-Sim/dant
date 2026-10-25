package work

import (
	"context"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
	"testing"
)

func runtimeEvent(method string, params contracts.RawObject, turn string) runtime.Event {
	params["threadId"] = raw("thread-fixture")
	params["turnId"] = raw(turn)
	return runtime.Event{Method: method, Params: params}
}

func savedUnfinished(t *testing.T, persistence *store.Store) (string, string) {
	t.Helper()
	ctx := context.Background()
	plan, _ := workstate.PublicPlan([]contracts.PlanStep{{Step: "verify actual result", Status: contracts.PlanStepStatusPending}}, nil)
	record, err := persistence.RegisterWork(ctx, store.RegisterWorkOptions{TurnID: "previous-turn", Title: "entrusted work", Source: "chat", Plan: &plan, StartedAt: 1000})
	if err != nil {
		t.Fatal(err)
	}
	_, err = persistence.UpdateRegisteredWork(ctx, "previous-turn", store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true, At: 1000})
	if err != nil {
		t.Fatal(err)
	}
	err = persistence.Mutate(ctx, func(state *contracts.State) error {
		state.ThreadID = contracts.Some("thread-fixture")
		state.ThreadRuntime = contracts.Some("vm:fixture")
		state.ThreadConversationID = state.ConversationID
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return record.ID, record.TurnID
}

func continueFixture(t *testing.T, engine *Engine, worker *fakeWorker, workID, fromTurn, newTurn string) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: fromTurn})
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	read := nextRequest(t, worker, "thread/read")
	replyContinuationInventory(t, worker, read, continuationBehaviorThread(fromTurn))
	start := nextRequest(t, worker, "turn/start")
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(newTurn)})}}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestAutomaticContinuationRemainsQuietUntilItsActualPlanIsVerified(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "continuation-turn")
	if err := engine.Handle(context.Background(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("output"), "delta": raw("still checking")}, "continuation-turn")); err != nil {
		t.Fatal(err)
	}
	if len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("automatic narration leaked into chat")
	}
	owner := ToolContext{ConversationID: persistence.Snapshot().ConversationID, ThreadID: "thread-fixture", TurnID: "continuation-turn", WorkID: workID, Owner: "continuation-turn"}
	owner.IsCurrent = func() bool {
		return engine.Current(owner)
	}
	receipt, err := engine.DeliverText(context.Background(), "intermediate update", owner)
	if err != nil {
		t.Fatal(err)
	}
	var delivery struct {
		Sent, Quiet, Buffered bool
	}
	if json.Unmarshal(receipt, &delivery) != nil || delivery.Sent || !delivery.Quiet || !delivery.Buffered {
		t.Fatal("buffered output claimed delivery")
	}
	_, err = engine.Tool(context.Background(), "task_plan", contracts.RawObject{"workId": raw(workID), "title": raw("entrusted work"), "steps": json.RawMessage(`[{"step":"actual result verified","status":"completed"}]`)}, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err = engine.Handle(context.Background(), terminal("continuation-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Role != contracts.RoleAssistant || state.WorkTasks[0].Status != contracts.WorkStatusReview {
		t.Fatal("verified continuation did not publish one result awaiting acceptance")
	}
	if state.WorkTasks[0].Continuation.Dispatch != nil {
		t.Fatal("terminal dispatch stayed active")
	}
}

func TestContinuationChecksActualIdleThreadBeforeSendingAnyNewAction(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	done := make(chan error, 1)
	go func() {
		_, err := engine.ContinueRegisteredWork(context.Background(), workID, ContinueOptions{ExpectedTurnID: fromTurn})
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	read := nextRequest(t, worker, "thread/read")
	assertContinuationMetadataRequest(t, read)
	read.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"active"},"turns":[]}`)}}
	if err := <-done; err == nil {
		t.Fatal("busy executor admitted continuation")
	}
	if persistence.Snapshot().WorkTasks[0].Continuation.Dispatch != nil {
		t.Fatal("known unsubmitted rejection retained uncertain dispatch")
	}
	select {
	case request := <-worker.requests:
		t.Fatalf("busy thread was submitted: %s", request.method)
	default:
	}
}
