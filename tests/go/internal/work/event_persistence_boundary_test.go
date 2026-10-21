package work

import (
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestOutputAndPlanWriteFailuresDoNotPublishUncommittedMessagesOrRegisteredWork(t *testing.T) {
	for _, phase := range []string{"first delta", "completed item", "stream completion", "observed plan"} {
		t.Run(phase, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				if phase == "observed plan" {
					return len(state.WorkTasks) > 0
				}
				if len(state.Messages) != 2 {
					return false
				}
				if phase == "first delta" {
					return state.Messages[1].Status.Value == contracts.MessageStatusStreaming
				}
				return state.Messages[1].Status.Value == contracts.MessageStatus(contracts.TaskStatusCompleted)
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "output-save-failure-turn")
			if phase == "stream completion" {
				if err := engine.Handle(t.Context(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("output"), "delta": raw("Preserved streaming text")}, owner.TurnID)); err != nil {
					t.Fatal(err)
				}
			}
			fault.armed.Store(true)
			event := runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("output"), "type": raw("agentMessage"), "text": raw("Final text not committed")})}, owner.TurnID)
			if phase == "first delta" {
				event = runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("output"), "delta": raw("Uncommitted streaming text")}, owner.TurnID)
			} else if phase == "observed plan" {
				event = runtimeEvent("turn/plan/updated", contracts.RawObject{"plan": raw([]contracts.PlanStep{{Step: "Uncommitted plan", Status: contracts.PlanStepStatusPending}})}, owner.TurnID)
			}
			err := engine.Handle(t.Context(), event)
			if phase == "observed plan" {
				if err != nil || len(persistence.Snapshot().WorkTasks) != 0 {
					t.Fatal("failed observed plan was retained as registered work", err)
				}
			} else if !errors.Is(err, store.ErrPersistence) {
				t.Fatal("failed output persistence was reported committed", err)
			}
			state := persistence.Snapshot()
			if fault.failures.Load() != 1 || engine.Snapshot().Active == nil || !owner.IsCurrent() {
				t.Fatal("local event save failure replayed or retired the actual execution")
			}
			if phase == "stream completion" {
				if len(state.Messages) != 2 || state.Messages[1].Text != "Preserved streaming text" || state.Messages[1].Status.Value != contracts.MessageStatusStreaming {
					t.Fatal("failed completion replaced the last committed stream snapshot")
				}
			} else if len(state.Messages) != 1 {
				t.Fatal("failed local event save partially appended chat history")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestNativeExecutionObservationAndProviderPlanShareOneVoiceWorkRecord(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	thread := openNativeBehaviorThread(t, engine, worker)
	owner, err := engine.AdoptNativeTurn(t.Context(), NativeTurnInput{ConversationID: persistence.ConversationID(), CallID: "call", ThreadID: thread, TurnID: "native-plan-turn", HandoffID: "handoff"})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.HandleNativeEvent(t.Context(), owner, runtimeEvent("item/started", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("command"), "type": raw("commandExecution")})}, owner.TurnID)); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.WorkTasks) != 1 || state.WorkTasks[0].Source != "voice" || !state.WorkTasks[0].Provisional {
		t.Fatal("native execution observation created a chat task or lost its provisional ownership")
	}
	id := state.WorkTasks[0].ID
	if err := engine.HandleNativeEvent(t.Context(), owner, runtimeEvent("turn/plan/updated", contracts.RawObject{"plan": raw([]contracts.PlanStep{{Step: "Preserve exact voice ownership", Status: contracts.PlanStepStatusInProgress}})}, owner.TurnID)); err != nil {
		t.Fatal(err)
	}
	state = persistence.Snapshot()
	if len(state.WorkTasks) != 1 || state.WorkTasks[0].ID != id || state.WorkTasks[0].Plan == nil || state.WorkTasks[0].Source != "voice" || state.WorkTasks[0].TurnID != owner.TurnID || len(state.Messages) != 0 {
		t.Fatal("observed voice plan duplicated work or copied a private call into chat")
	}
	if err := engine.HandleNativeEvent(t.Context(), owner, terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
}
