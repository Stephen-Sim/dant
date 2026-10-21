package work

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestFollowupReleasesOnlyItsReservationWhenItsCapturedTurnHasEnded(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Retained follow-up"})
	if err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	engine.pendingFollowups[message.ID] = true
	engine.mu.Unlock()
	before := persistence.Revision()
	if _, err := engine.followup(t.Context(), message, "retired-turn", true); !errors.Is(err, ErrStaleOwner) || len(engine.Snapshot().PendingFollowups) != 0 || persistence.Revision() != before {
		t.Fatal("stale reserved follow-up retained its slot or changed saved input", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestFollowupCapacityAndSerializedOwnerChangesCannotStartAnExtraSteer(t *testing.T) {
	for _, scenario := range []string{"capacity", "owner ended while waiting"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "serialized-followup-turn")
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Additional authored request"})
			if err != nil {
				t.Fatal(err)
			}
			before := persistence.Revision()
			if scenario == "capacity" {
				engine.mu.Lock()
				for index := range MaxPendingFollowups {
					engine.pendingFollowups[fmt.Sprintf("existing-%d", index)] = true
				}
				engine.mu.Unlock()
				if _, err := engine.Followup(t.Context(), message, owner.TurnID); !errors.Is(err, ErrBusy) || len(engine.Snapshot().PendingFollowups) != MaxPendingFollowups || persistence.Revision() != before {
					t.Fatal("follow-up overflow changed admitted work or claimed another slot", err)
				}
			} else {
				engine.mu.Lock()
				active := engine.active
				engine.mu.Unlock()
				active.steer.Lock()
				locked := true
				defer func() {
					if locked {
						active.steer.Unlock()
					}
				}()
				done := make(chan error, 1)
				go func() {
					_, err := engine.Followup(t.Context(), message, owner.TurnID)
					done <- err
				}()
				deadline := time.NewTimer(5 * time.Second)
				defer deadline.Stop()
				poll := time.NewTicker(time.Millisecond)
				defer poll.Stop()
				for len(engine.Snapshot().PendingFollowups) != 1 {
					select {
					case <-poll.C:
					case <-deadline.C:
						t.Fatal("serialized follow-up did not register its reservation")
					}
				}
				if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
					t.Fatal(err)
				}
				active.steer.Unlock()
				locked = false
				if err := awaitWorkAction(t, done); !errors.Is(err, ErrStaleOwner) || len(engine.Snapshot().PendingFollowups) != 0 {
					t.Fatal("serialized follow-up continued after its turn ended", err)
				}
				stored, err := persistence.Message(message.ID)
				if err != nil || stored.Submission.Present || stored.TurnID.Present || stored.Text != message.Text {
					t.Fatal("retired turn changed a follow-up that had never been submitted", err)
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestFollowupReferenceFailuresAndConversationReplacementNeverDispatch(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "reference read failure", true: "conversation replaced during reference"}[replace], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "reference-followup-turn")
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Follow-up must retain its original owner"})
			if err != nil {
				t.Fatal(err)
			}
			failure := errors.New("isolated_followup_reference_failure")
			engine.options.Memory = ReferenceMemoryFunc(func(ctx context.Context, _, _, _ string) (string, error) {
				if !replace {
					return "", failure
				}
				return "Existing reference", persistence.Mutate(ctx, func(state *contracts.State) error {
					state.ConversationID = store.UUID()
					return nil
				})
			})
			_, err = engine.Followup(t.Context(), message, owner.TurnID)
			if replace && !errors.Is(err, ErrStaleOwner) || !replace && !errors.Is(err, failure) || len(engine.Snapshot().PendingFollowups) != 0 {
				t.Fatal("failed or detached reference preparation retained a follow-up admission", err)
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Submission.Value != contracts.SubmissionStatusPreparing || stored.TurnID.Present || stored.Text != message.Text {
				t.Fatal("unsubmitted follow-up acquired an executor acknowledgement", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
