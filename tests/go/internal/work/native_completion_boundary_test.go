package work

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestNativeTaskPlanRetainsItsSavedInputAndHumanBlockerAfterExecutionEnds(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "The current saved call input"})
	if err != nil {
		t.Fatal(err)
	}
	thread := openNativeBehaviorThread(t, engine, worker)
	ended := []string{}
	engine.options.OwnerEnded = func(id string) { ended = append(ended, id) }
	owner, err := engine.AdoptNativeTurn(t.Context(), NativeTurnInput{
		ConversationID: persistence.ConversationID(), CallID: "saved-input-call", ThreadID: thread,
		TurnID: "saved-input-native-turn", HandoffID: "saved-input-handoff", MessageIDs: []string{message.ID},
	})
	if err != nil || owner.MessageID != message.ID {
		t.Fatal("native admission lost the exact saved input owner", err)
	}
	event := workRequest(t, owner, "item/tool/requestUserInput", raw("native-form"), nil)
	if err := engine.Handle(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Tool(t.Context(), "task_plan", behaviorPlan("Needs human input", contracts.PlanStepStatusPending), owner); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.WorkTasks) != 1 || state.WorkTasks[0].Source != "voice" || state.WorkTasks[0].Status != contracts.WorkStatusWaitingUser || state.WorkTasks[0].MessageID.Value != message.ID {
		t.Fatal("native plan invented a chat owner or cleared the pending human blocker")
	}
	if err := engine.HandleNativeEvent(t.Context(), owner, terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	if len(ended) != 1 || ended[0] != owner.TurnID || len(state.Messages) != 1 || state.Messages[0].Text != message.Text || state.WorkTasks[0].Status != contracts.WorkStatusWaitingUser || engine.Snapshot().Active != nil || owner.IsCurrent() {
		t.Fatal("ended native turn completed blocked work, duplicated call text, or retained tools")
	}
	assertWorkerQuiet(t, worker)
}

func TestPrivateVoiceTaskWithoutSpokenOutputReturnsOnlyItsVerifiedCompletionReceipt(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "silent-result-call", Provider: "api"}}
	result := make(chan voiceTaskResult, 1)
	go func() {
		value, err := engine.RunVoiceTask(t.Context(), "Complete only this authorized task", ToolContext{CallID: "silent-result-call", IsCurrent: func() bool { return true }})
		result <- voiceTaskResult{value: value, err: err}
	}()
	acceptThreadAndTurn(t, worker, "silent-result-turn")
	owner := waitToolScope(t, engine, "silent-result-turn")
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	var completed voiceTaskResult
	select {
	case completed = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("private completed task did not release its owned waiter")
	}
	var receipt struct{ Result string }
	if completed.err != nil || json.Unmarshal(completed.value, &receipt) != nil || receipt.Result != "Task completed." || len(persistence.Snapshot().Messages) != 0 || unconfirmedVoiceTasks(persistence.Snapshot()) || owner.IsCurrent() {
		t.Fatal("silent completed work lost its receipt, leaked private input, or retained an unresolved fence", completed.err)
	}
	assertWorkerQuiet(t, worker)
}

func TestContinuationReplaysOnlyItsAcknowledgedBufferedEvent(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
	read := nextRequest(t, worker, "thread/read")
	read.result <- fakeResponse{value: contracts.RawObject{"thread": raw(continuationBehaviorThread(fromTurn))}}
	start := nextRequest(t, worker, "turn/start")
	if err := engine.Handle(t.Context(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("buffered-continuation-output"), "delta": raw("Still verifying the existing task")}, "buffered-continuation-turn")); err != nil {
		t.Fatal(err)
	}
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("buffered-continuation-turn")})}}
	if err := awaitWorkAction(t, done); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	active := engine.active
	valid := active != nil && active.startAcknowledged && active.turnID == "buffered-continuation-turn" && active.outputs["buffered-continuation-output"] == "Still verifying the existing task" && len(active.early) == 0
	engine.mu.Unlock()
	if !valid || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("buffered continuation event was lost, replayed before acknowledgement, or published as a new message")
	}
	assertWorkerQuiet(t, worker)
}
