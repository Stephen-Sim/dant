package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestExecutorToolCapacityRejectsOverflowWithoutStartingOrLosingItsCurrentOwner(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "bounded-tool-owner")
	for range MaxToolWorkers {
		engine.toolSlots <- struct{}{}
	}
	request := workRequest(t, owner, "item/tool/call", raw("overflow-tool"), contracts.RawObject{"tool": raw("task_list"), "arguments": raw(contracts.RawObject{})})
	before := persistence.Revision()
	worker.events <- request
	reply := nextWorkReply(t, worker)
	if reply.id.Key() != request.ID.Value.Key() || !json.Valid(reply.result) || persistence.Revision() != before || !owner.IsCurrent() {
		t.Fatal("tool overflow executed, changed history, or displaced its acknowledged owner")
	}
	var rejected struct{ Code int }
	if json.Unmarshal(reply.result, &rejected) != nil || rejected.Code != unsupportedRequestCode {
		t.Fatal("overflow did not return a correlated explicit rejection")
	}
	for range MaxToolWorkers {
		<-engine.toolSlots
	}
	request = workRequest(t, owner, "item/tool/call", raw("available-tool"), contracts.RawObject{"tool": raw("task_list"), "arguments": raw(contracts.RawObject{})})
	worker.events <- request
	reply = nextWorkReply(t, worker)
	var accepted struct{ Success bool }
	if reply.id.Key() != request.ID.Value.Key() || json.Unmarshal(reply.result, &accepted) != nil || !accepted.Success || !owner.IsCurrent() {
		t.Fatal("released tool capacity could not serve its original execution owner")
	}
	assertWorkerQuiet(t, worker.fakeWorker)
}

func TestLateUserInputAndToolRequestsCannotUseAnEndedExecution(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "retired-request-owner")
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	before := persistence.Revision()
	for _, method := range []string{"item/tool/requestUserInput", "item/tool/call"} {
		event := workRequest(t, owner, method, raw(method), contracts.RawObject{"tool": raw("task_list"), "arguments": raw(contracts.RawObject{})})
		if err := engine.handleRequest(t.Context(), event, active); err != nil || nextWorkReply(t, worker).id.Key() != event.ID.Value.Key() {
			t.Fatal("late request did not receive its own bounded rejection", err)
		}
	}
	active.nativeBackground = true
	event := workRequest(t, owner, "item/tool/requestUserInput", raw("retired-background-input"), nil)
	if err := engine.requestChatInput(t.Context(), event, active); err != nil || nextWorkReply(t, worker).id.Key() != event.ID.Value.Key() || persistence.Revision() != before {
		t.Fatal("late background input published a blocker in a retired task", err)
	}
	if err := engine.interrupt(t.Context(), active); err != nil {
		t.Fatal("retired stop callback interrupted a replacement execution", err)
	}
	if engine.Snapshot().Active != nil || len(engine.Snapshot().PendingFollowups) != 0 {
		t.Fatal("late requests recreated an execution or admission")
	}
	assertWorkerQuiet(t, worker.fakeWorker)
}

type replyLifetimeBoundary struct {
	Worker
	onReply func() error
}

func (worker replyLifetimeBoundary) Reply(context.Context, runtime.RPCID, json.RawMessage) error {
	return worker.onReply()
}

func TestUserInputReplyThatOutlivesItsOwnerCannotResumeOrRewriteTheTask(t *testing.T) {
	for _, failSave := range []bool{false, true} {
		t.Run(map[bool]string{false: "owner closed after reply", true: "waiting save rejected"}[failSave], func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				return len(state.Messages) == 1 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusRunning)
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			message, owner := beginBehaviorTurn(t, engine, persistence, worker, "input-reply-owner")
			event := workRequest(t, owner, "item/tool/requestUserInput", raw("input-reply"), nil)
			if err := engine.Handle(t.Context(), event); err != nil {
				t.Fatal(err)
			}
			replies := 0
			engine.worker = replyLifetimeBoundary{Worker: worker, onReply: func() error {
				replies++
				if failSave {
					fault.armed.Store(true)
					return nil
				}
				return engine.Close()
			}}
			err := engine.RespondToUser(t.Context(), event.ID.Value, raw(contracts.RawObject{"accepted": raw(true)}))
			if failSave && !errors.Is(err, store.ErrPersistence) || !failSave && !errors.Is(err, ErrStaleOwner) || replies != 1 {
				t.Fatal("reply acknowledgement resumed an expired or unpersisted task", err)
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Text != message.Text || failSave && stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusWaitingUser) {
				t.Fatal("failed reply settlement changed authored input or invented a saved running status", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
