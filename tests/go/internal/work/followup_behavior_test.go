package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestSteeringPreservesItsOneAcknowledgedOwnerAfterTheHTTPWaiterAborts(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	initial, owner := beginBehaviorTurn(t, engine, persistence, worker, "steer-owned-turn")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	result := make(chan error, 1)
	go func() {
		_, err := engine.Steer(ctx, owner.ConversationID, owner.TurnID, "  additional authorized instruction  ", initial.ID)
		result <- err
	}()
	request := nextRequest(t, worker, "turn/steer")
	if eventString(request.params, "threadId") != owner.ThreadID || eventString(request.params, "expectedTurnId") != owner.TurnID {
		t.Fatal("steering changed its captured thread or turn")
	}
	if !strings.Contains(string(request.params["input"]), "additional authorized instruction") {
		t.Fatal("steering dropped the human's accepted text")
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 2 {
		t.Fatal("steering did not persist exactly one human follow-up")
	}
	followup := state.Messages[1]
	if followup.Text != "additional authorized instruction" || followup.ReplyTo.Value != initial.ID || followup.ParentTaskID.Value != initial.ID {
		t.Fatal("steering lost its human reply identity")
	}
	cancel()
	if err := awaitWorkAction(t, result); !errors.Is(err, context.Canceled) {
		t.Fatal("aborted HTTP waiter did not end independently", err)
	}
	if request.ctx.Err() != nil {
		t.Fatal("HTTP cancellation cancelled admitted executor input")
	}

	request.result <- fakeResponse{value: contracts.RawObject{}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		message, err := persistence.Message(followup.ID)
		return err == nil && message.Submission.Value == contracts.SubmissionStatusConfirmed && len(snapshot.PendingFollowups) == 0
	})
	stored, err := persistence.Message(followup.ID)
	if err != nil || stored.TurnID.Value != owner.TurnID || stored.UnknownOutcome || !stored.ExecutorConfirmedAt.Present {
		t.Fatal("acknowledged follow-up was not retained under the existing owner", err)
	}
	current, valid := engine.ToolScope()
	if !valid || current.TurnID != owner.TurnID || len(current.MessageIDs) != 2 {
		t.Fatal("steering created a second executor or lost the original task")
	}
	assertWorkerQuiet(t, worker)
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{initial.ID, followup.ID} {
		message, err := persistence.Message(id)
		if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) {
			t.Fatal("one terminal did not settle every input owned by that turn", err)
		}
	}
}

func TestSteeringRejectsBlankCancelledAndStaleRequestsBeforePersistingThem(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "steer-validation-turn")
	before := len(persistence.Snapshot().Messages)
	if _, err := engine.Steer(context.Background(), owner.ConversationID, owner.TurnID, " \n\t ", ""); err == nil {
		t.Fatal("blank steering was persisted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.Steer(ctx, owner.ConversationID, owner.TurnID, "cancelled fixture", ""); !errors.Is(err, context.Canceled) {
		t.Fatal("pre-cancelled steering reached admission", err)
	}
	for _, target := range []struct{ conversationID, turnID, replyTo string }{
		{"different-conversation", owner.TurnID, ""},
		{owner.ConversationID, "different-turn", ""},
		{owner.ConversationID, owner.TurnID, "nonexistent-message"},
	} {
		if _, err := engine.Steer(context.Background(), target.conversationID, target.turnID, "stale fixture", target.replyTo); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("stale steering was accepted", err)
		}
	}
	if _, err := engine.Followup(context.Background(), nil, owner.TurnID); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("nil follow-up was accepted", err)
	}
	if len(persistence.Snapshot().Messages) != before || len(engine.Snapshot().PendingFollowups) != 0 {
		t.Fatal("rejected steering changed durable history or pending admission")
	}
	assertWorkerQuiet(t, worker)
}

func TestFollowupDistinguishesKnownUnsentFailureFromAnUnknownActionAndNeverRetries(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		name := "known-unsent"
		if unknown {
			name = "unknown-sent"
		}
		t.Run(name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			initial, owner := beginBehaviorTurn(t, engine, persistence, worker, "followup-failure-turn")
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "additional isolated instruction"})
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				_, err := engine.Followup(context.Background(), message, owner.TurnID)
				result <- err
			}()
			request := nextRequest(t, worker, "turn/steer")
			if _, err := engine.Followup(context.Background(), message, owner.TurnID); !errors.Is(err, ErrStaleOwner) {
				t.Fatal("a duplicate follow-up was submitted while its first outcome was pending", err)
			}
			assertWorkerQuiet(t, worker)
			request.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: unknown}}
			if err := awaitWorkAction(t, result); err == nil {
				t.Fatal("failed follow-up claimed success")
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.UnknownOutcome != unknown || stored.ParentTaskID.Value != initial.ID {
				t.Fatal("follow-up failure lost its submission certainty or parent", err)
			}
			wanted := contracts.SubmissionStatusNotSubmitted
			if unknown {
				wanted = contracts.SubmissionStatusUnknown
			}
			if stored.Submission.Value != wanted || len(engine.Snapshot().PendingFollowups) != 0 || engine.Snapshot().Executor.Paused != unknown {
				t.Fatal("failure classification changed execution ownership or left a pending replay")
			}
			if _, valid := engine.ToolScope(); valid == unknown {
				t.Fatal("tool authority did not follow confirmed versus uncertain ownership")
			}
			engine.Wake()
			assertWorkerQuiet(t, worker)
			if err := engine.Handle(context.Background(), terminal(owner.TurnID, "interrupted")); err != nil {
				t.Fatal(err)
			}
		})
	}
}
