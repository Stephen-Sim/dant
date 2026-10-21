package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestAllMessageAdmissionPathsHonorThePersistedExecutorStopFence(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic integration input", ClientMessageID: "tg:fixture-input", Source: contracts.RawObject{"type": raw("telegram")}})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.FenceUnconfirmedStop(t.Context()); err != nil {
		t.Fatal(err)
	}
	before := persistence.Revision()
	if err := engine.Enqueue(t.Context(), message); !errors.Is(err, ErrUnknown) {
		t.Fatal("enqueue bypassed an unconfirmed executor stop", err)
	}
	if err := engine.AdmitExternalMessage(t.Context(), persistence.ConversationID(), message); !errors.Is(err, ErrUnknown) {
		t.Fatal("integration admission bypassed an unconfirmed executor stop", err)
	}
	if _, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "New synthetic input"}); !errors.Is(err, ErrUnknown) {
		t.Fatal("public admission bypassed an unconfirmed executor stop", err)
	}
	if persistence.Revision() != before || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("stop-fenced admission changed durable input or queued execution")
	}
	assertWorkerQuiet(t, worker)
}

func TestPublicAdmissionRejectsOfflineAndUnencodableInputsWithoutPartialPersistence(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	for _, input := range []*contracts.ChatMessage{
		{Role: contracts.RoleUser, Text: "Synthetic input", Extra: contracts.RawObject{"unencodable": json.RawMessage(`invalid JSON`)}},
		{Role: contracts.RoleUser, Text: "Synthetic input", LegacyText: contracts.LegacyJSON{Original: contracts.RawObject{"text": raw(17)}, Decoded: map[string]string{"text": "Synthetic input"}}},
	} {
		if _, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), input); err == nil || len(persistence.Snapshot().Messages) != 0 {
			t.Fatal("unencodable or malformed DTO reached durable admission", err)
		}
	}
	engine.worker = unavailableVoiceWorker{fakeWorker: worker}
	if _, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Offline synthetic request"}); !errors.Is(err, runtime.ErrDisconnected) || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("offline admission persisted a request without an available execution boundary", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestHistoryOwnershipIncludesMediaAndRejectsFailedLocalOperationsAtomically(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &unfinishedMediaCalls{admissionCalls: &admissionCalls{call: contracts.Call{ID: "history-media-call", Provider: "api"}}}
	failure := errors.New("isolated history operation failure")
	before := persistence.Revision()
	if err := engine.HistoryTransaction(t.Context(), func(owner history.Ownership) (history.QueueChange, error) {
		if !owner.Call || !owner.NativeVoiceActive {
			t.Error("history transaction omitted the media ownership boundary")
		}
		return history.QueueChange{EnqueueID: "must-not-enter"}, failure
	}); !errors.Is(err, failure) || persistence.Revision() != before || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("failed history operation partially changed execution admission", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestPlanRegistrationFailurePreservesTheAcknowledgedExecutionWithoutInventingWork(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.WorkTasks) > 0 }}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "plan-registration-failure-turn")
	fault.armed.Store(true)
	if _, err := engine.Tool(t.Context(), "task_plan", behaviorPlan("Synthetic work plan", contracts.PlanStepStatusPending), owner); !errors.Is(err, store.ErrPersistence) || len(persistence.Snapshot().WorkTasks) != 0 || !owner.IsCurrent() {
		t.Fatal("failed plan registration claimed a persisted work identity", err)
	}
	forged := owner
	forged.TurnID = "foreign-turn"
	forged.IsCurrent = func() bool { return true }
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("Forged plan", contracts.PlanStepStatusPending), forged); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("plan tool trusted a callback over the exact active turn", err)
	}
	if _, err := engine.Tool(t.Context(), "task_cancel", contracts.RawObject{}, owner); err == nil {
		t.Fatal("cancellation without a selected work identity was accepted")
	}
	assertWorkerQuiet(t, worker)
}
