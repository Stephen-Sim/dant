package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestFollowupPersistenceFailuresFenceOnlyActuallySubmittedInput(t *testing.T) {
	for _, phase := range []contracts.SubmissionStatus{contracts.SubmissionStatusPreparing, contracts.SubmissionStatusSubmitting, contracts.SubmissionStatusConfirmed} {
		t.Run(string(phase), func(t *testing.T) {
			var followupID string
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				message, err := store.FindMessage(&state, followupID)
				return err == nil && message.Submission.Value == phase
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "followup-persistence-turn")
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "isolated followup requiring durable receipt"})
			if err != nil {
				t.Fatal(err)
			}
			followupID = message.ID
			fault.armed.Store(true)
			done := make(chan error, 1)
			go func() {
				_, err := engine.Followup(context.Background(), message, owner.TurnID)
				done <- err
			}()
			if phase == contracts.SubmissionStatusConfirmed {
				request := nextRequest(t, worker, "turn/steer")
				request.result <- fakeResponse{value: contracts.RawObject{}}
			}
			if err := awaitWorkAction(t, done); !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("failed followup persistence claimed accepted input", err)
			}
			if len(engine.Snapshot().PendingFollowups) != 0 {
				t.Fatal("failed followup retained a pending admission")
			}
			_, valid := engine.ToolScope()
			if phase == contracts.SubmissionStatusConfirmed {
				if valid || !engine.Snapshot().Executor.Paused || engine.Snapshot().Active == nil {
					t.Fatal("unpersisted acknowledged input retained tools or discarded the unknown owner")
				}
			} else if !valid || engine.Snapshot().Executor.Paused {
				t.Fatal("known pre-submit persistence failure revoked unrelated acknowledged work")
			}
			assertWorkerQuiet(t, worker)
			if phase == contracts.SubmissionStatusConfirmed {
				if err := engine.Close(); err != nil {
					t.Fatal(err)
				}
				directory := persistence.Directory()
				persistence.Close()
				reopened, err := store.Open(directory, store.Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				retained, err := reopened.Message(message.ID)
				if err != nil || !retained.UnknownOutcome || retained.Submission.Value != contracts.SubmissionStatusUnknown || retained.TurnID.Value != "" || retained.ExecutorConfirmedAt.Present && !retained.ExecutorConfirmedAt.Null {
					t.Fatal("reopening made an unpersisted acknowledged followup safe to repeat", err)
				}
			}
		})
	}
}

func TestLateFollowupAcknowledgementCannotModifyAReplacementConversation(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(map[bool]string{false: "acknowledged", true: "unknown"}[uncertain], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "followup-stale-owner-turn")
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "old conversation instruction"})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := engine.Followup(context.Background(), message, owner.TurnID)
				done <- err
			}()
			request := nextRequest(t, worker, "turn/steer")
			if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
				state.ConversationID = store.UUID()
				state.Messages = []*contracts.ChatMessage{{
					ID: message.ID, Role: contracts.RoleUser,
					Text: "replacement conversation draft", Time: message.Time,
					Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft)),
				}}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			response := fakeResponse{value: contracts.RawObject{}}
			if uncertain {
				response.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
			}
			request.result <- response
			if err := awaitWorkAction(t, done); err == nil || !uncertain && !errors.Is(err, ErrStaleOwner) {
				t.Fatal("late outcome did not reject its retired conversation", err)
			}
			retained, err := persistence.Message(message.ID)
			if err != nil || retained.Text != "replacement conversation draft" || retained.Submission.Present || retained.TurnID.Present || retained.ExecutorConfirmedAt.Present || retained.Status.Value != contracts.MessageStatus(contracts.TaskStatusDraft) {
				t.Fatal("late acknowledgement changed a replacement conversation's message", err)
			}
			assertWorkerQuiet(t, worker)
			if engine.Snapshot().Executor.Paused {
				t.Fatal("retired input outcome paused the replacement conversation")
			}
		})
	}
}
