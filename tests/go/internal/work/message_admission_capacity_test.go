package work

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestOrdinaryHumanAdmissionSteersItsAcknowledgedTurnWithoutCreatingAnotherExecutor(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "ordinary-message-owner")
	receipt, err := engine.AdmitMessage(t.Context(), owner.ConversationID, &contracts.ChatMessage{Role: contracts.RoleUser, Text: "An additional instruction for this turn", ClientMessageID: admissionClientID})
	if err != nil || receipt.Message == nil || receipt.Queued || receipt.SteerTurnID != owner.TurnID || receipt.CallID != "" {
		t.Fatal("ordinary follow-up did not select the current acknowledged executor", err)
	}
	request := nextRequest(t, worker, "turn/steer")
	if eventString(request.params, "expectedTurnId") != owner.TurnID {
		t.Fatal("ordinary admission changed its captured execution identity")
	}
	request.result <- fakeResponse{value: contracts.RawObject{}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return len(snapshot.PendingFollowups) == 0 })
	stored, err := persistence.Message(receipt.Message.ID)
	if err != nil || stored.Submission.Value != contracts.SubmissionStatusConfirmed || stored.TurnID.Value != owner.TurnID || len(engine.Snapshot().Queue) != 0 || !owner.IsCurrent() {
		t.Fatal("accepted ordinary follow-up lost its one executor receipt", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestMessageAdmissionAndPersistedRepliesRejectCapacityAndUnknownActiveOwners(t *testing.T) {
	for _, scenario := range []string{"ordinary overflow", "persisted reply overflow", "unknown active reply", "unknown persisted reply"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "admission-capacity-owner")
			if _, err := engine.Tool(t.Context(), "task_plan", behaviorPlan("Retained task", contracts.PlanStepStatusPending), owner); err != nil {
				t.Fatal(err)
			}
			workID := persistence.Snapshot().WorkTasks[0].ID
			message := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "One additional authorized input", ClientMessageID: admissionClientID}
			persisted := scenario == "persisted reply overflow" || scenario == "unknown persisted reply"
			if scenario != "ordinary overflow" {
				message.WorkID = workID
				message.WorkReply = &contracts.WorkReplyTarget{WorkID: workID, TurnID: owner.TurnID, ConversationID: owner.ConversationID}
			}
			if persisted {
				var err error
				message, err = persistence.Add(t.Context(), message)
				if err != nil {
					t.Fatal(err)
				}
			}
			engine.mu.Lock()
			unknown := scenario == "unknown active reply" || scenario == "unknown persisted reply"
			if unknown {
				engine.active.unknown = true
			} else {
				for index := range MaxPendingFollowups {
					engine.pendingFollowups[fmt.Sprintf("previously-admitted-%d", index)] = true
				}
			}
			engine.mu.Unlock()
			before := persistence.Revision()
			var err error
			if persisted {
				err = engine.Enqueue(t.Context(), message)
			} else {
				_, err = engine.AdmitMessage(t.Context(), owner.ConversationID, message)
			}
			want := runtime.ErrBackpressure
			if unknown {
				want = ErrUnknown
			}
			if !errors.Is(err, want) || persistence.Revision() != before || engine.Snapshot().Active == nil || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("rejected admission changed history, queued work, or displaced the active owner", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanReplyCannotClaimAnUnendedUnownedWorkRecord(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "unended-foreign-turn", Source: "chat", Title: "Unended observed work", Observed: true})
	if err != nil {
		t.Fatal(err)
	}
	before := persistence.Revision()
	_, err = engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Reply must wait for reconciliation", ClientMessageID: admissionClientID,
		WorkReply: &contracts.WorkReplyTarget{WorkID: record.ID, TurnID: record.TurnID, ConversationID: persistence.ConversationID()},
	})
	if !errors.Is(err, ErrStaleOwner) || persistence.Revision() != before || len(persistence.Snapshot().Messages) != 0 || engine.Snapshot().Active != nil {
		t.Fatal("unended saved work became permission to create an independent executor", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestSteerRequiresItsPersistedInputAndReturnsTheActualReceipt(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(map[bool]string{false: "acknowledged", true: "input save rejected"}[reject], func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.Messages) == 2 }}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "steer-persistence-owner")
			fault.armed.Store(reject)
			done := make(chan error, 1)
			go func() {
				_, err := engine.Steer(t.Context(), owner.ConversationID, owner.TurnID, "Additional scoped input", "")
				done <- err
			}()
			if !reject {
				request := nextRequest(t, worker, "turn/steer")
				request.result <- fakeResponse{value: contracts.RawObject{}}
			}
			err := awaitWorkAction(t, done)
			if reject && !errors.Is(err, store.ErrPersistence) || !reject && err != nil || !owner.IsCurrent() || len(engine.Snapshot().PendingFollowups) != 0 {
				t.Fatal("steering lost its persistence or acknowledgement classification", err)
			}
			wantMessages := 2
			if reject {
				wantMessages = 1
			}
			if len(persistence.Snapshot().Messages) != wantMessages {
				t.Fatal("steering changed history independently of its saved receipt")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
