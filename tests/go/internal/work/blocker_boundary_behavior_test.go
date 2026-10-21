package work

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type fallbackBlockerWorker struct{ Worker }

func TestBackgroundQuestionPersistenceFailuresDoNotSendAFalseProviderAcknowledgement(t *testing.T) {
	for _, phase := range []string{"waiting state", "blocker message"} {
		t.Run(phase, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				if phase == "waiting state" {
					return len(state.Messages) == 1 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusWaitingUser)
				}
				return len(state.Messages) > 1
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "blocker-write-failure-turn")
			engine.mu.Lock()
			engine.active.nativeBackground = true
			engine.mu.Unlock()
			id, _ := runtime.ParseRPCID(raw("blocker-write-request"))
			event := runtimeEvent("item/tool/requestUserInput", contracts.RawObject{"questions": raw([]contracts.RawObject{{"question": raw("Synthetic question")}})}, owner.TurnID)
			event.ID = contracts.Some(id)
			fault.armed.Store(true)
			if err := engine.Handle(t.Context(), event); !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("failed blocker write appeared to succeed", err)
			}
			if len(persistence.Snapshot().Messages) != 1 {
				t.Fatal("failed blocker write left a partial chat message")
			}
			select {
			case <-worker.replies:
				t.Fatal("unwritten blocker was acknowledged to the provider")
			default:
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestCredentialNoticeWriteFailureRollsBackItsWaitingState(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.Messages) > 1 }}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "credential-notice-failure-turn")
	engine.mu.Lock()
	engine.active.nativeBackground = true
	engine.mu.Unlock()
	fault.armed.Store(true)
	if _, err := engine.BeginCredentialWait(owner); !errors.Is(err, store.ErrPersistence) {
		t.Fatal("unwritten credential notice retained a waiting handle", err)
	}
	saved, err := persistence.Message(message.ID)
	if err != nil || saved.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) || engine.Snapshot().Active.Status != contracts.TaskStatusRunning || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("failed notice retained a phantom credential blocker", err)
	}
	finish, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal("later independent credential wait inherited the failed count", err)
	}
	finish()
	if engine.Snapshot().Active.Status != contracts.TaskStatusRunning {
		t.Fatal("completed credential wait retained the failed notice blocker")
	}
	assertWorkerQuiet(t, worker)
}

func TestCredentialWaitingRejectsAnAuthoritativeTurnMismatch(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "credential-owner-boundary-turn")
	owner.ThreadID = "replacement-thread"
	owner.IsCurrent = func() bool { return true }
	if _, err := engine.BeginCredentialWait(owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("credential wait trusted a callback over the authoritative thread", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestUnsupportedInputFallbackNeverSynthesizesAHumanAnswer(t *testing.T) {
	engine, _, worker := engineFixture(t)
	engine.worker = fallbackBlockerWorker{Worker: worker}
	if err := engine.replyRequestError(t.Context(), runtime.Event{}, "Fixed rejection"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-worker.replies:
		t.Fatal("notification was answered as an RPC request")
	default:
	}
	id, _ := runtime.ParseRPCID(raw("fallback-request"))
	if err := engine.replyRequestError(t.Context(), runtime.Event{ID: contracts.Some(id)}, "Fixed rejection"); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Success      bool                  `json:"success"`
		ContentItems []contracts.RawObject `json:"contentItems"`
	}
	if json.Unmarshal(<-worker.replies, &response) != nil || response.Success || len(response.ContentItems) != 1 || string(response.ContentItems[0]["text"]) != `"Fixed rejection"` {
		t.Fatal("compatibility fallback answered the form with invented user content")
	}
	assertWorkerQuiet(t, worker)
}

func TestBlankBlockerDoesNotCreateAnEmptyAssistantMessage(t *testing.T) {
	engine, active, worker := backgroundFixture(t)
	before := engine.store.Revision()
	engine.mu.Lock()
	err := engine.publishBlockerLocked(active, " \t\n", "input")
	engine.mu.Unlock()
	if err != nil || engine.store.Revision() != before || len(engine.store.Snapshot().Messages) != 1 {
		t.Fatal("blank blocker created visible chat or completion state", err)
	}
	assertWorkerQuiet(t, worker)
}
