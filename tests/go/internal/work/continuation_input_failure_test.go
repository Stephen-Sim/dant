package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestHumanContinuationPersistenceFailuresRetainTheirExactDispatchOutcome(t *testing.T) {
	for _, phase := range []contracts.SubmissionStatus{contracts.SubmissionStatusPreparing, contracts.SubmissionStatusSubmitting, contracts.SubmissionStatusConfirmed} {
		t.Run(string(phase), func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				return len(state.Messages) == 1 && state.Messages[0].Submission.Value == phase
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			ended := []string{}
			engine.options.OwnerEnded = func(id string) { ended = append(ended, id) }
			workID, fromTurn := savedUnfinished(t, persistence)
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Continue only this explicit adjustment", WorkID: workID,
				WorkReply: &contracts.WorkReplyTarget{WorkID: workID, TurnID: fromTurn, ConversationID: persistence.ConversationID()},
			})
			if err != nil {
				t.Fatal(err)
			}
			fault.armed.Store(true)
			done := make(chan error, 1)
			go func() {
				_, err := engine.ContinueRegisteredWork(t.Context(), workID, ContinueOptions{ExpectedTurnID: fromTurn, Message: message})
				done <- err
			}()
			resume := nextRequest(t, worker, "thread/resume")
			resume.result <- fakeResponse{value: contracts.RawObject{}}
			if phase != contracts.SubmissionStatusPreparing {
				read := nextRequest(t, worker, "thread/read")
				replyContinuationInventory(t, worker, read, continuationBehaviorThread(fromTurn))
			}
			if phase == contracts.SubmissionStatusConfirmed {
				start := nextRequest(t, worker, "turn/start")
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("human-unpersisted-turn")})}}
			}
			if err := awaitWorkAction(t, done); !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("failed human continuation persistence claimed successful admission", err)
			}
			state := persistence.Snapshot()
			record, err := store.FindWork(&state, workID)
			unknown := phase != contracts.SubmissionStatusPreparing
			if err != nil || engine.Snapshot().Active != nil || engine.Snapshot().Executor.Paused != unknown {
				t.Fatal("failed continuation lost its retained owner or pause fence", err)
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Text != message.Text || stored.UnknownOutcome != unknown || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
				t.Fatal("failed continuation changed authored input or its external outcome", err)
			}
			if unknown {
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch == nil || stored.Submission.Value != contracts.SubmissionStatusUnknown {
					t.Fatal("unconfirmed continuation was made safe to replay")
				}
			} else if record.Status != contracts.WorkStatusPaused || record.Continuation.Dispatch != nil {
				t.Fatal("known unsubmitted human reply retained a phantom dispatch")
			}
			if phase == contracts.SubmissionStatusConfirmed && (len(ended) != 1 || ended[0] != "human-unpersisted-turn") || phase != contracts.SubmissionStatusConfirmed && len(ended) != 0 {
				t.Fatal("continuation failure revoked an invented turn or retained an acknowledged owner")
			}
			engine.Wake()
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanContinuationReferenceFailureCannotDispatchOrLoseItsSavedInput(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Use this new authorized adjustment", WorkID: workID,
		WorkReply: &contracts.WorkReplyTarget{WorkID: workID, TurnID: fromTurn, ConversationID: persistence.ConversationID()},
	})
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("isolated_human_reference_failure")
	engine.options.Memory = ReferenceMemoryFunc(func(context.Context, string, string, string) (string, error) {
		return "", failure
	})
	done := make(chan error, 1)
	go func() {
		_, err := engine.ContinueRegisteredWork(t.Context(), workID, ContinueOptions{ExpectedTurnID: fromTurn, Message: message})
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	read := nextRequest(t, worker, "thread/read")
	replyContinuationInventory(t, worker, read, continuationBehaviorThread(fromTurn))
	if err := awaitWorkAction(t, done); !errors.Is(err, failure) {
		t.Fatal("failed human reference preparation was accepted", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Text != message.Text || stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusPreparing || engine.Snapshot().Executor.Paused || engine.Snapshot().Active != nil {
		t.Fatal("known preparation failure lost authored input or invented an external action", err)
	}
	assertWorkerQuiet(t, worker)
}
