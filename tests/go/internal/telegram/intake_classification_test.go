package telegram

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestTextOnlyAdmissionRejectionDoesNotInventAnAttachmentOrQueueFailure(t *testing.T) {
	fixture := fixture(t)
	var codes []IntakeFailureCode
	fixture.Gateway.options.ReportIncomingFailure = func(code IntakeFailureCode) {
		codes = append(codes, code)
		_ = fixture.Gateway.Status()
		_ = fixture.Store.Snapshot()
	}
	fixture.Admit = func(context.Context, string, *contracts.ChatMessage) error {
		return errors.New("private executor admission rejection")
	}
	update := behaviorUpdate(t, 100, "retained text-only input")
	if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
		t.Fatal(err)
	}
	state := fixture.Store.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Error.Value != "The Telegram message could not enter the task queue; it was not retried." {
		t.Fatal("text-only admission was misreported as an attachment or queue-capacity failure")
	}
	if strings.Contains(string(raw(state)), "private executor") || len(state.Messages[0].Attachments) != 0 {
		t.Fatal("admission failure exposed private detail or invented an attachment")
	}
	if len(codes) != 1 || codes[0] != IntakeAdmissionRejected {
		t.Fatal("admission failure lost its bounded operational classification")
	}
	if err := fixture.Gateway.Receive(t.Context(), update); err != nil || fixture.Admitted.Load() != 1 || len(fixture.Store.Snapshot().Messages) != 1 {
		t.Fatal("failed update was replayed", err)
	}
}

func TestIncomingFailureStagesRemainDistinctAndNeverReplayTheReceipt(t *testing.T) {
	for _, code := range []IntakeFailureCode{IntakeQueueFull, IntakeAttachmentFailed, IntakePersistenceFailed, IntakeCancelled, IntakeTimeout} {
		t.Run(string(code), func(t *testing.T) {
			fixture := fixture(t)
			var reported []IntakeFailureCode
			fixture.Gateway.options.ReportIncomingFailure = func(actual IntakeFailureCode) { reported = append(reported, actual) }
			update := behaviorUpdate(t, 100, "preserved intake failure")
			switch code {
			case IntakeQueueFull:
				fixture.Gateway.options.WorkSnapshot = func() WorkState { return WorkState{Queue: make([]string, maxIncomingQueue)} }
			case IntakeAttachmentFailed:
				update.Message.Document = &File{ID: ""}
			case IntakePersistenceFailed:
				mutations := 0
				fixture.Gateway.options.Store = controlledMirrorPersistence{Persistence: fixture.Store,
					mutate: func(ctx context.Context, apply func(*contracts.State) error) error {
						mutations++
						if mutations == 2 {
							return errors.New("private persistence failure")
						}
						return fixture.Store.Mutate(ctx, apply)
					}}
			case IntakeCancelled:
				fixture.Admit = func(context.Context, string, *contracts.ChatMessage) error { return context.Canceled }
			case IntakeTimeout:
				fixture.Admit = func(context.Context, string, *contracts.ChatMessage) error { return context.DeadlineExceeded }
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			state := fixture.Store.Snapshot()
			if len(reported) != 1 || reported[0] != code || len(state.Messages) != 1 ||
				state.Messages[0].Error.Value != fixture.Gateway.intakeFailureText(code) ||
				state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) ||
				fixture.Gateway.config.Receipts[0].Status != ReceiptFailed || fixture.Gateway.config.Offset != 101 {
				t.Fatal("intake failure lost its exact stage, saved message, or failed receipt")
			}
			before := fixture.Admitted.Load()
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil || fixture.Admitted.Load() != before || len(reported) != 1 {
				t.Fatal("failure callback or admission was replayed", err)
			}
		})
	}
}

func TestAdmissionFailureDoesNotOverwriteAnUnknownOrConfirmedSubmission(t *testing.T) {
	for _, submission := range []contracts.SubmissionStatus{contracts.SubmissionStatusUnknown, contracts.SubmissionStatusSubmitting, contracts.SubmissionStatusConfirmed} {
		t.Run(string(submission), func(t *testing.T) {
			fixture := fixture(t)
			fixture.Admit = func(ctx context.Context, _ string, message *contracts.ChatMessage) error {
				_, err := fixture.Store.Update(ctx, message.ID, contracts.MessagePatch{
					"submission": raw(submission), "error": raw("preserved submission evidence"),
				})
				if err != nil {
					return err
				}
				return errors.New("private rejected admission")
			}
			if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, 100, "submission evidence")); err != nil {
				t.Fatal(err)
			}
			message := fixture.Store.Snapshot().Messages[0]
			if message.Submission.Value != submission || message.Error.Value != "preserved submission evidence" {
				t.Fatal("intake error rewrote submission uncertainty or confirmation")
			}
		})
	}
}

func TestCancelledGatewayCannotStartLatePolling(t *testing.T) {
	fixture := fixture(t)
	fixture.Gateway.cancel()
	fixture.Gateway.options.AutoPoll = true
	fixture.Gateway.Start()
	if fixture.Gateway.loopDone != nil {
		t.Fatal("cancelled owner created new polling workers")
	}
}
