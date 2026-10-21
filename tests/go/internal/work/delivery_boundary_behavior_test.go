package work

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestDeliveryRejectsMismatchedTurnEvenWhenTheCallerClaimsToBeCurrent(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "delivery-owner-turn")
	forged := owner
	forged.TurnID = "different-turn"
	forged.IsCurrent = func() bool { return true }
	if _, err := engine.DeliverText(t.Context(), "Synthetic output", forged); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("caller callback replaced the authoritative active turn", err)
	}
	if _, err := engine.DeliverAttachments(t.Context(), deliveryBehaviorFiles(t, 1), forged); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("file delivery accepted another turn", err)
	}
	if thread, err := engine.Thread(t.Context()); err != nil || thread != owner.ThreadID {
		t.Fatal("active thread request did not use the exact current owner", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestDeliveredMessageBudgetRejectsAdditionalOutputsWithoutAnotherWrite(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "delivery-budget-turn")
	for index := 0; index < workstate.ObservedItems; index++ {
		if _, err := engine.DeliverText(t.Context(), fmt.Sprintf("Synthetic bounded output %d", index), owner); err != nil {
			t.Fatal("valid output did not fill its bounded delivery allowance", err)
		}
	}
	revision := persistence.Revision()
	if _, err := engine.DeliverText(t.Context(), "Excess output", owner); !errors.Is(err, runtime.ErrBackpressure) || persistence.Revision() != revision {
		t.Fatal("output budget overflow changed durable chat", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestAttachmentTargetCreationFailureDoesNotInventAnOutputReceipt(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.Messages) > 1 }}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "delivery-target-failure-turn")
	fault.armed.Store(true)
	if _, err := engine.DeliverAttachments(t.Context(), deliveryBehaviorFiles(t, 1), owner); !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
		t.Fatal("unwritten attachment target produced a successful delivery", err)
	}
	if len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("failed attachment target left a partial message")
	}
	assertWorkerQuiet(t, worker)
}

func TestQuietAttachmentBudgetRetainsTheLatestDistinctFiles(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, previous := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, previous, "quiet-file-budget-turn")
	owner := waitToolScope(t, engine, "quiet-file-budget-turn")
	attachments := deliveryBehaviorFiles(t, MaxDeliveredFiles+2)
	for index := range attachments {
		attachments[index].SHA256 = fmt.Sprintf("fixture-sha256-%d", index)
	}
	if _, err := engine.DeliverAttachments(t.Context(), attachments, owner); err != nil {
		t.Fatal(err)
	}
	plan := behaviorPlan("Verified bounded file output", contracts.PlanStepStatusCompleted)
	plan["workId"] = raw(workID)
	if _, err := engine.Tool(t.Context(), "task_plan", plan, owner); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || len(state.Messages[0].Attachments) != MaxDeliveredFiles {
		t.Fatal("quiet publication did not enforce its file allowance")
	}
	for index, file := range state.Messages[0].Attachments {
		if file.ID != attachments[index+2].ID || file.SHA256 != attachments[index+2].SHA256 {
			t.Fatal("quiet budget retained an older file or changed its content identity")
		}
	}
}

func TestConcurrentSuccessfulThreadWaitersShareOneDurableBinding(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		engine, persistence, worker := engineFixture(t)
		done := make(chan error, 2)
		for range 2 {
			go func() {
				thread, err := engine.Thread(context.Background())
				if err == nil && thread != "shared-success-thread" {
					err = errors.New("incorrect shared thread")
				}
				done <- err
			}()
		}
		synctest.Wait()
		request := nextRequest(t, worker, "thread/start")
		request.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("shared-success-thread")})}}
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal("joined thread handshake failed", err)
			}
		}
		if persistence.Snapshot().ThreadID.Value != "shared-success-thread" {
			t.Fatal("shared thread was not durably bound")
		}
		assertWorkerQuiet(t, worker)
	})
}
