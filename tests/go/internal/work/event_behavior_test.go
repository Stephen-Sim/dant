package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestExecutionEventsRecordActualWorkWithoutTreatingMetadataToolsAsExecution(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "observed-work-turn")
	metadata := []string{
		"task_plan", "task_list", "task_cancel", "send_message", "send_chat_message", "end_call",
		"react_message", "memory_write", "skill_list", "skill_get", "credential_find", "credential_get",
		"schedule_list", "schedule_save", "schedule_delete", "",
	}
	for _, name := range metadata {
		for _, kind := range []string{"mcpToolCall", "dynamicToolCall"} {
			event := runtimeEvent("item/started", contracts.RawObject{"item": raw(contracts.RawObject{"type": raw(kind), "tool": raw(name)})}, owner.TurnID)
			if err := engine.Handle(context.Background(), event); err != nil || len(persistence.Snapshot().WorkTasks) != 0 {
				t.Fatal("a metadata-only tool invented observed execution", kind, name, err)
			}
		}
	}
	for index, fixture := range []struct {
		kind  string
		tool  string
		stage contracts.TaskProgressStage
	}{
		{"commandExecution", "", contracts.TaskProgressStageCommand},
		{"fileChange", "", contracts.TaskProgressStageFiles},
		{"imageGeneration", "", contracts.TaskProgressStageFiles},
		{"imageView", "", contracts.TaskProgressStageComputer},
		{"mcpToolCall", "computer", contracts.TaskProgressStageComputer},
		{"dynamicToolCall", "create_output", contracts.TaskProgressStageWorking},
		{"webSearch", "", contracts.TaskProgressStageWorking},
		{"collabAgentToolCall", "", contracts.TaskProgressStageWorking},
	} {
		event := runtimeEvent("item/started", contracts.RawObject{"item": raw(contracts.RawObject{
			"id": raw(fmt.Sprintf("observed-%d", index)), "type": raw(fixture.kind), "tool": raw(fixture.tool),
		})}, owner.TurnID)
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
		state, execution := engine.StateSnapshot()
		if execution.Active == nil || execution.Active.Step != fixture.stage || len(state.WorkTasks) != 1 || !state.WorkTasks[0].Provisional || state.WorkTasks[0].TurnID != owner.TurnID {
			t.Fatal("execution events lost progress or created unrelated durable work", fixture.kind)
		}
	}
	if stored, err := persistence.Message(owner.MessageID); err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) {
		t.Fatal("observing an execution item completed the entrusted work", err)
	}
}

func TestAgentOutputEventsStreamOneMessageAndIgnoreDuplicateOrForeignNotifications(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-private", "[redacted]")
	}
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "output-event-turn")
	signals, unsubscribe, err := engine.SubscribeSignals()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	for _, text := range []string{"first ", "fixture-private"} {
		event := runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("agent-output"), "delta": raw(text)}, owner.TurnID)
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
		signal := <-signals
		var delta struct{ ID, Delta string }
		if signal.Type != "delta" || json.Unmarshal(signal.Data, &delta) != nil || delta.ID == "" || strings.Contains(delta.Delta, "fixture-private") {
			t.Fatal("browser delta exposed raw text or lost its message identity")
		}
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 2 || state.Messages[1].Text != "first [redacted]" || state.Messages[1].TaskID.Value != message.ID || state.Messages[1].Status.Value != contracts.MessageStatusStreaming {
		t.Fatal("streaming deltas created duplicate or unowned chat messages")
	}
	completed := runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{
		"id": raw("agent-output"), "type": raw("agentMessage"), "text": raw("final fixture-private"),
	})}, owner.TurnID)
	if err := engine.Handle(context.Background(), completed); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), completed); err != nil {
		t.Fatal(err)
	}
	for _, event := range []runtime.Event{
		runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("agent-output"), "delta": raw("late")}, owner.TurnID),
		runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw(""), "delta": raw("invalid")}, owner.TurnID),
		runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("bad-delta"), "delta": raw(1)}, owner.TurnID),
		runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("foreign"), "delta": raw("foreign")}, "foreign-turn"),
	} {
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
	}
	state = persistence.Snapshot()
	if len(state.Messages) != 2 || state.Messages[1].Text != "final [redacted]" || state.Messages[1].Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || engine.CombinedOutput() != "final fixture-private" {
		t.Fatal("a duplicate or foreign event rewrote the completed output")
	}
	invalid := runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("invalid-completion"), "type": raw("agentMessage"), "text": raw(2)})}, owner.TurnID)
	if err := engine.Handle(context.Background(), invalid); !errors.Is(err, runtime.ErrInvalidProtocol) || len(persistence.Snapshot().Messages) != 2 {
		t.Fatal("non-text provider output entered chat", err)
	}
}

func TestObservedPlansRespectWaitingInputAndKeepTheirExactRegisteredIdentity(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "observed-plan-turn")
	plan := func(status contracts.PlanStepStatus) runtime.Event {
		return runtimeEvent("turn/plan/updated", contracts.RawObject{"plan": raw([]contracts.PlanStep{{Step: "verified work", Status: status}})}, owner.TurnID)
	}
	if err := engine.Handle(context.Background(), plan(contracts.PlanStepStatusInProgress)); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.WorkTasks) != 1 || state.WorkTasks[0].Plan == nil {
		t.Fatal("provider plan was not registered as durable work")
	}
	workID := state.WorkTasks[0].ID
	input := workRequest(t, owner, "item/tool/requestUserInput", raw("plan-input"), nil)
	if err := engine.Handle(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	for _, status := range []contracts.PlanStepStatus{contracts.PlanStepStatusInProgress, contracts.PlanStepStatusCompleted} {
		if err := engine.Handle(context.Background(), plan(status)); err == nil {
			t.Fatal("provider plan bypassed a pending human input blocker")
		}
	}
	if err := engine.Handle(context.Background(), plan(contracts.PlanStepStatusPending)); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	record, err := store.FindWork(&state, workID)
	if err != nil || len(state.WorkTasks) != 1 || record.Status != contracts.WorkStatusWaitingUser || record.Plan.Completed != 0 || record.TurnID != owner.TurnID {
		t.Fatal("waiting plan created a replacement task or lost its blocked status", err)
	}
	if err := engine.RespondToUser(context.Background(), input.ID.Value, raw("confirmed input")); err != nil {
		t.Fatal(err)
	}
	_ = nextWorkReply(t, worker)
	if err := engine.Handle(context.Background(), plan(contracts.PlanStepStatusCompleted)); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	record, err = store.FindWork(&state, workID)
	if err != nil || record.Plan.Completed != 1 || engine.Snapshot().Active == nil {
		t.Fatal("plan completion ended the actual execution or changed its work identity", err)
	}
}

func TestSlowSignalSubscribersAreBoundedWithoutBlockingExecutionOrOtherSubscribers(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "bounded-signal-turn")
	subscribers := make([]<-chan Signal, 0, MaxSignalSubscribers)
	for range MaxSignalSubscribers {
		channel, cancel, err := engine.SubscribeSignals()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(cancel)
		subscribers = append(subscribers, channel)
	}
	if _, _, err := engine.SubscribeSignals(); !errors.Is(err, ErrBusy) {
		t.Fatal("signal subscriber admission was unbounded", err)
	}
	for index := range SignalQueue + 1 {
		event := runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("bounded-output"), "delta": raw("x")}, owner.TurnID)
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
		if signal, open := <-subscribers[0]; !open || signal.Type != "delta" {
			t.Fatal("a slow peer blocked the consuming browser", index)
		}
	}
	for _, channel := range subscribers[1:] {
		count := 0
		for range channel {
			count++
		}
		if count != SignalQueue {
			t.Fatal("overflowed subscribers lost the bound or remained connected", count)
		}
	}
	if _, cancel, err := engine.SubscribeSignals(); err != nil {
		t.Fatal("retired slow subscribers kept the admission slots", err)
	} else {
		cancel()
		cancel()
	}
	if engine.CombinedOutput() != strings.Repeat("x", SignalQueue+1) || len(persistence.Snapshot().Messages) != 2 {
		t.Fatal("signal backpressure interrupted durable chat output")
	}
}
