package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestPublicAdmissionRejectsInvalidMessagesBeforeAnyDurableOrExternalChange(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	for _, fixture := range []struct {
		name    string
		message *contracts.ChatMessage
	}{
		{"missing", nil},
		{"assistant", &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "forged speaker"}},
		{"blank", &contracts.ChatMessage{Role: contracts.RoleUser, Text: " \n\t"}},
		{"invalid-client", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "input", ClientMessageID: "tg:untrusted-client"}},
		{"missing-file-id", &contracts.ChatMessage{Role: contracts.RoleUser, Attachments: []contracts.Attachment{{Name: "file.txt"}}}},
		{"duplicate-file", &contracts.ChatMessage{Role: contracts.RoleUser, Attachments: []contracts.Attachment{{ID: "same-file"}, {ID: "same-file"}}}},
		{"too-many-files", &contracts.ChatMessage{Role: contracts.RoleUser, Attachments: make([]contracts.Attachment, MaxDeliveredFiles+1)}},
		{"unknown-reply", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "reply", ReplyTo: contracts.Some("missing-message")}},
		{"invalid-id", &contracts.ChatMessage{ID: "bad\x00identity", Role: contracts.RoleUser, Text: "input"}},
		{"task-reply-missing-client", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "task reply", WorkReply: &contracts.WorkReplyTarget{WorkID: "work", TurnID: "turn", ConversationID: persistence.ConversationID()}}},
		{"task-reply-wrong-conversation", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "task reply", ClientMessageID: admissionClientID, WorkReply: &contracts.WorkReplyTarget{WorkID: "work", TurnID: "turn", ConversationID: "other-conversation"}}},
		{"task-reply-missing-work", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "task reply", ClientMessageID: admissionClientID, WorkReply: &contracts.WorkReplyTarget{WorkID: "missing-work", TurnID: "turn", ConversationID: persistence.ConversationID()}}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), fixture.message); err == nil {
				t.Fatal("invalid public input entered the conversation")
			}
			if len(persistence.Snapshot().Messages) != 0 || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("failed validation partially persisted or queued a message")
			}
		})
	}
	if _, err := engine.AdmitMessage(context.Background(), "", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "input"}); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("empty conversation identity was accepted", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestPublicAdmissionDeduplicationIncludesReplyAttachmentOrderAndExplicitWorkScope(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	reservation, err := engine.ReserveCallStart(context.Background(), "deduplication-hold", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.ReleaseCallStart(reservation)
	prior, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "reference"})
	if err != nil {
		t.Fatal(err)
	}
	input := &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "  exact request  ", ClientMessageID: admissionClientID, ReplyTo: contracts.Some(prior.ID),
		Attachments: []contracts.Attachment{{ID: "owned-file-first"}, {ID: "owned-file-second"}},
	}
	accepted, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), input)
	if err != nil || accepted.Message.Text != "exact request" || !accepted.Queued {
		t.Fatal("initial validated input was not admitted once", err)
	}
	for _, mutate := range []func(*contracts.ChatMessage){
		func(input *contracts.ChatMessage) { input.ReplyTo = contracts.Null[string]() },
		func(input *contracts.ChatMessage) { input.Attachments = input.Attachments[:1] },
		func(input *contracts.ChatMessage) {
			input.Attachments = []contracts.Attachment{input.Attachments[1], input.Attachments[0]}
		},
		func(input *contracts.ChatMessage) {
			input.WorkReply = &contracts.WorkReplyTarget{WorkID: "work", TurnID: "turn", ConversationID: persistence.ConversationID()}
		},
	} {
		changed := *input
		mutate(&changed)
		var conflict *contracts.APIError
		if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &changed); !errors.As(err, &conflict) || conflict.Code != "client_message_conflict" {
			t.Fatal("changed reply/attachment/task scope reused another request's receipt", err)
		}
	}
	if receipt, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), input); err != nil || !receipt.Existing || receipt.Message.ID != accepted.Message.ID {
		t.Fatal("exact duplicate failed its immutable request receipt", err)
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{ID: prior.ID, Role: contracts.RoleUser, Text: "different request"}); !errors.Is(err, store.ErrMessageConflict) {
		t.Fatal("public message ID replaced existing history", err)
	}
	if len(persistence.Snapshot().Messages) != 2 || len(engine.Snapshot().Queue) != 1 {
		t.Fatal("conflicting duplicates changed durable history or execution admission")
	}
	assertWorkerQuiet(t, worker)
}

func TestPublicTaskReplyAdmissionUsesTheExistingOwnerAndRetainsAnUnknownSteerFence(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "admission-steer-turn")
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("current task", contracts.PlanStepStatusPending), owner); err != nil {
		t.Fatal(err)
	}
	workID := persistence.Snapshot().WorkTasks[0].ID
	input := &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "explicit current-task adjustment", ClientMessageID: admissionClientID,
		WorkReply: &contracts.WorkReplyTarget{WorkID: workID, TurnID: owner.TurnID, ConversationID: owner.ConversationID},
	}
	ctx, cancel := context.WithCancel(context.Background())
	receipt, err := engine.AdmitMessage(ctx, owner.ConversationID, input)
	if err != nil || receipt.Queued || receipt.SteerTurnID != owner.TurnID || receipt.Message.WorkID != workID || receipt.Message.WorkKind != "task" {
		t.Fatal("explicit task reply created a second execution instead of steering its captured owner", err)
	}
	cancel()
	request := nextRequest(t, worker, "turn/steer")
	if request.ctx.Err() != nil || eventString(request.params, "expectedTurnId") != owner.TurnID {
		t.Fatal("HTTP cancellation discarded an already durably admitted follow-up")
	}
	request.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return len(state.PendingFollowups) == 0 && state.Executor.Paused
	})
	stored, err := persistence.Message(receipt.Message.ID)
	if err != nil || !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || owner.IsCurrent() {
		t.Fatal("unknown steering result lost its fence or retained tool authority", err)
	}
	if repeated, err := engine.AdmitMessage(context.Background(), owner.ConversationID, input); err != nil || !repeated.Existing || repeated.Message.ID != receipt.Message.ID {
		t.Fatal("duplicate unknown input was recreated instead of returning its existing receipt", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestAdmissionWhileMediaOrHumanControlIsPresentPreservesItsCapturedContext(t *testing.T) {
	for _, provider := range []string{"api", "subscription"} {
		t.Run(provider, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "exact-context-call", Provider: provider}}
			if err := engine.Pause(context.Background()); err != nil {
				t.Fatal(err)
			}
			receipt, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "new human input", Attachments: []contracts.Attachment{{ID: "validated-input-file"}},
			})
			if err != nil || receipt.Queued || receipt.CallID != "" || receipt.ContextCallID != "exact-context-call" || receipt.ContextProvider != provider || receipt.Message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
				t.Fatal("paused admission lost the captured media context or executed new input", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
