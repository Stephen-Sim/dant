package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestProgressAcceptanceRequiresAnEndedOwnerAndRetainsTheFullConversation(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "progress-acceptance-turn")
	if err := engine.SetProgressPriority(context.Background(), message.ID, store.ProgressTask, contracts.TaskPriorityHigh); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Confirm(context.Background(), message.ID); !errors.Is(err, ErrBusy) {
		t.Fatal("a running task was accepted before its terminal outcome", err)
	}
	if err := engine.DismissProgress(context.Background(), message.ID, store.ProgressTask, store.DismissOptions{ConfirmUnfinished: true}); !errors.Is(err, ErrBusy) {
		t.Fatal("a live task could be hidden while it owned the executor", err)
	}
	receipt, err := engine.Tool(context.Background(), "task_plan", contracts.RawObject{
		"title": raw("verified isolated task"),
		"steps": json.RawMessage(`[{"step":"actual isolated result verified","status":"completed"}]`),
	}, owner)
	if err != nil {
		t.Fatal(err)
	}
	var planned struct {
		Saved  bool   `json:"saved"`
		WorkID string `json:"workId"`
	}
	if json.Unmarshal(receipt, &planned) != nil || !planned.Saved || planned.WorkID == "" {
		t.Fatal("completed plan did not remain registered under its work identity")
	}
	if err := engine.SetProgressPriority(context.Background(), planned.WorkID, store.ProgressWork, contracts.TaskPriorityLow); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.ResumeProgress(context.Background(), planned.WorkID, store.ProgressWork, owner.TurnID); !errors.Is(err, ErrBusy) {
		t.Fatal("a registered live task was resumed beside its current execution", err)
	}
	if count, err := engine.ClearCompletedProgress(context.Background()); err != nil || count != 0 {
		t.Fatal("a completed checklist hid a task that still owned execution", count, err)
	}
	if _, err := engine.DeliverText(context.Background(), "Verified isolated result for human review.", owner); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}

	accepted, err := engine.Confirm(context.Background(), message.ID)
	if err != nil || accepted.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || !accepted.AcceptedAt.Present || accepted.ProgressPriority.Value != contracts.TaskPriorityHigh {
		t.Fatal("human acceptance lost its status, timestamp or priority", err)
	}
	state := persistence.Snapshot()
	record, err := store.FindWork(&state, planned.WorkID)
	if err != nil || record.Status != contracts.WorkStatusCompleted || record.ProgressPriority.Value != contracts.TaskPriorityLow {
		t.Fatal("human acceptance did not settle the exact registered task", err)
	}
	before := len(state.Messages)
	count, err := engine.ClearCompletedProgress(context.Background())
	if err != nil || count < 2 {
		t.Fatal("completed progress could not be hidden after explicit acceptance", count, err)
	}
	state = persistence.Snapshot()
	record, err = store.FindWork(&state, planned.WorkID)
	accepted, messageErr := persistence.Message(message.ID)
	if err != nil || messageErr != nil || !record.ProgressDismissedAt.Present || !accepted.ProgressDismissedAt.Present || len(state.Messages) != before {
		t.Fatal("clearing progress removed history or missed its accepted identities", err, messageErr)
	}
	if count, err := engine.ClearCompletedProgress(context.Background()); err != nil || count != 0 {
		t.Fatal("already-hidden progress was counted or changed again", count, err)
	}
	assertWorkerQuiet(t, worker)
}

func TestHidingUnfinishedProgressRequiresExactIdentityAndAnExplicitConfirmation(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "unfinished retained task", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
		Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted),
	})
	if err != nil {
		t.Fatal(err)
	}
	identity := store.DismissOptions{
		ExpectedConversationID: contracts.Some(persistence.ConversationID()), ExpectedTurnID: contracts.Null[string](),
	}
	err = engine.DismissProgress(context.Background(), message.ID, store.ProgressTask, identity)
	var confirmation *store.ProgressError
	if !errors.As(err, &confirmation) || !confirmation.ConfirmationNeeded() {
		t.Fatal("unfinished work was hidden without a meaningful confirmation", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.ProgressDismissedAt.Present {
		t.Fatal("rejected confirmation changed progress", err)
	}
	identity.ConfirmUnfinished = true
	stale := identity
	stale.ExpectedTurnID = contracts.Some("retired-turn")
	if err := engine.DismissProgress(context.Background(), message.ID, store.ProgressTask, stale); err == nil {
		t.Fatal("a stale selected card hid current progress")
	}
	if err := engine.DismissProgress(context.Background(), message.ID, store.ProgressTask, identity); err != nil {
		t.Fatal(err)
	}
	stored, err = persistence.Message(message.ID)
	if err != nil || !stored.ProgressDismissedAt.Present || stored.Text != message.Text || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted {
		t.Fatal("hiding progress deleted or resumed the retained task", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestResumeRegisteredProgressRequiresTheExactPausedSelection(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, turnID := savedUnfinished(t, persistence)
	if _, err := persistence.UpdateRegisteredWork(t.Context(), turnID, store.UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.ResumeProgress(t.Context(), workID, store.ProgressWork, "retired-turn"); err == nil {
		t.Fatal("stale selected turn was admitted")
	}
	if _, err := engine.ResumeProgress(t.Context(), workID, store.ProgressTask, turnID); !errors.Is(err, ErrBusy) {
		t.Fatal("wrong kind was admitted", err)
	}
	if _, err := engine.ResumeProgressForConversation(t.Context(), "retired-conversation", workID, store.ProgressWork, turnID); err == nil {
		t.Fatal("stale conversation was admitted")
	}
	state := persistence.Snapshot()
	record, _ := store.FindWork(&state, workID)
	if record.Status != contracts.WorkStatusPaused || record.Continuation != nil && record.Continuation.Dispatch != nil {
		t.Fatal("rejected selection acquired a dispatch")
	}
	assertWorkerQuiet(t, worker)
}
