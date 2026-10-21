package work

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestExplicitResumePreservesFIFOAndCannotRaceACallStartReservation(t *testing.T) {
	for _, allPaused := range []bool{false, true} {
		name := "selected-deduplicated"
		if allPaused {
			name = "all-paused"
		}
		t.Run(name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			if err := engine.Pause(context.Background()); err != nil {
				t.Fatal(err)
			}
			messages := []*contracts.ChatMessage{}
			for _, text := range []string{"first retained request", "second retained request"} {
				message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
					Role: contracts.RoleUser, Text: text, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
					Submission: contracts.Some(contracts.SubmissionStatusConfirmed), TurnID: contracts.Some("previous-" + name),
				})
				if err != nil {
					t.Fatal(err)
				}
				messages = append(messages, message)
			}
			ignored, err := persistence.Add(context.Background(), &contracts.ChatMessage{
				Role: contracts.RoleAssistant, Text: "paused assistant history", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
			})
			if err != nil {
				t.Fatal(err)
			}

			reservation, err := engine.ReserveCallStart(context.Background(), "resume-call", "subscription")
			if err != nil || !engine.CallStartCurrent(reservation) {
				t.Fatal("call handshake did not capture its nonexecution reservation", err)
			}
			forged := reservation
			forged.Token = "another-reservation"
			engine.ReleaseCallStart(forged)
			if engine.CallStartCurrent(forged) || !engine.CallStartCurrent(reservation) {
				t.Fatal("a different call token released the actual handshake owner")
			}
			ids := []string{messages[0].ID, messages[0].ID, messages[1].ID}
			if allPaused {
				ids = nil
			}
			selected, err := engine.ResumePaused(context.Background(), ids, ResumeOptions{})
			wanted := []string{messages[0].ID, messages[1].ID}
			if err != nil || !reflect.DeepEqual(selected, wanted) || !reflect.DeepEqual(engine.Snapshot().Queue, wanted) {
				t.Fatal("explicit resume duplicated or reordered durable requests", err)
			}
			if engine.Snapshot().Executor.Paused {
				t.Fatal("explicit human resume did not release the paused queue")
			}
			for _, original := range messages {
				stored, err := persistence.Message(original.ID)
				if err != nil || stored.Text != original.Text || stored.Time != original.Time || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusQueued) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || !stored.TurnID.Null || !stored.ExecutorConfirmedAt.Null || !stored.QueuedAt.Present {
					t.Fatal("resume invented an identity/timestamp or retained an old executor acknowledgement", err)
				}
			}
			assistant, err := persistence.Message(ignored.ID)
			if err != nil || assistant.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
				t.Fatal("resume admitted assistant history as a human task", err)
			}
			assertWorkerQuiet(t, worker)

			engine.ReleaseCallStart(reservation)
			if engine.CallStartCurrent(reservation) {
				t.Fatal("released call token remained current")
			}
			acceptThreadAndTurn(t, worker, "resumed-first-turn")
			first := waitToolScope(t, engine, "resumed-first-turn")
			if first.MessageID != messages[0].ID || len(engine.Snapshot().Queue) != 1 {
				t.Fatal("resumed queue did not retain its one execution lane")
			}
			if err := engine.Handle(context.Background(), terminal(first.TurnID, "completed")); err != nil {
				t.Fatal(err)
			}
			request := nextRequest(t, worker, "turn/start")
			request.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("resumed-second-turn")})}}
			second := waitToolScope(t, engine, "resumed-second-turn")
			if second.MessageID != messages[1].ID {
				t.Fatal("second resumed request acquired another message's owner")
			}
			if err := engine.Handle(context.Background(), terminal(second.TurnID, "completed")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestResumeRequiresExplicitUnknownConfirmationAndRollsBackTheWholeSelection(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := engine.Pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	known, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "known retained request", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
		Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted),
	})
	if err != nil {
		t.Fatal(err)
	}
	uncertain, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "uncertain retained request", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
		Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{known.ID, uncertain.ID}
	if _, err := engine.ResumePaused(context.Background(), ids, ResumeOptions{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("unknown work resumed without a human's explicit confirmation", err)
	}
	for _, id := range ids {
		message, err := persistence.Message(id)
		if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
			t.Fatal("a rejected selection partially resumed earlier messages", err)
		}
	}
	if !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("unknown selection changed execution admission before confirmation")
	}
	assertWorkerQuiet(t, worker)

	reservation, err := engine.ReserveCallStart(context.Background(), "unknown-confirmation-call", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := engine.ResumePaused(context.Background(), ids, ResumeOptions{ConfirmUnknown: true})
	if err != nil || !reflect.DeepEqual(selected, ids) {
		t.Fatal("explicit reconciliation could not select the retained requests", err)
	}
	message, err := persistence.Message(uncertain.ID)
	if err != nil || message.UnknownOutcome || message.Submission.Value != contracts.SubmissionStatusNotSubmitted || message.Time != uncertain.Time {
		t.Fatal("confirmed retry retained an uncertain acknowledgement or changed creation time", err)
	}
	if !engine.CallStartCurrent(reservation) {
		t.Fatal("explicit resume invalidated an unrelated pending media handshake")
	}
	assertWorkerQuiet(t, worker)
}

func TestResumeRejectsForeignMissingAndAlreadyCompletedTargetsWithoutMutation(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	completed, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "completed retained request", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, ids := range [][]string{{"missing-message"}, {completed.ID}} {
		if _, err := engine.ResumePaused(context.Background(), ids, ResumeOptions{}); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("missing or completed work acquired a replay owner", err)
		}
	}
	selected, err := engine.ResumePaused(context.Background(), []string{}, ResumeOptions{})
	if err != nil || len(selected) != 0 || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("an explicitly empty selection resumed unrelated history", err)
	}
	assertWorkerQuiet(t, worker)
}
