package work

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestQueueAdmissionRejectsMissingNonhumanAndUncertainInputsWithoutChangingHistory(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := engine.Enqueue(context.Background(), nil); !errors.Is(err, store.ErrMessageNotFound) {
		t.Fatal("missing input entered the queue", err)
	}
	if err := engine.Enqueue(context.Background(), &contracts.ChatMessage{ID: "not-persisted"}); !errors.Is(err, store.ErrMessageNotFound) {
		t.Fatal("queue admission created an unpersisted message", err)
	}
	for _, scenario := range []string{"assistant", "unknown-flag", "unknown-submission", "submitting"} {
		message := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "preserved queue input"}
		switch scenario {
		case "assistant":
			message.Role = contracts.RoleAssistant
		case "unknown-flag":
			message.UnknownOutcome = true
		case "unknown-submission":
			message.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
		case "submitting":
			message.Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
		}
		stored, err := persistence.Add(context.Background(), message)
		if err != nil {
			t.Fatal(err)
		}
		before := persistence.Snapshot()
		err = engine.Enqueue(context.Background(), stored)
		if scenario == "assistant" && !errors.Is(err, store.ErrMessageNotFound) || scenario != "assistant" && !errors.Is(err, ErrUnknown) {
			t.Fatal("queue admission changed a missing or uncertain input's classification", scenario, err)
		}
		if !reflect.DeepEqual(before, persistence.Snapshot()) || len(engine.Snapshot().Queue) != 0 {
			t.Fatal("rejected queue input partially changed history or admitted work")
		}
	}
	assertWorkerQuiet(t, worker)
}

func TestQueueTaskRepliesValidateTheSavedTaskAndConversationBeforeAnySteer(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, turnID := savedUnfinished(t, persistence)
	for _, scenario := range []string{"conversation", "missing-work", "turn", "ended-task"} {
		target := &contracts.WorkReplyTarget{WorkID: workID, TurnID: turnID, ConversationID: persistence.ConversationID()}
		switch scenario {
		case "conversation":
			target.ConversationID = "other-conversation"
		case "missing-work":
			target.WorkID = "missing-work"
		case "turn":
			target.TurnID = "other-turn"
		case "ended-task":
			if _, err := persistence.UpdateRegisteredWork(context.Background(), turnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusRunning)}); err != nil {
				t.Fatal(err)
			}
		}
		message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "current human adjustment", WorkReply: target})
		if err != nil {
			t.Fatal(err)
		}
		if err := engine.Enqueue(context.Background(), message); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("queue admitted a task reply outside its saved eligible scope", scenario, err)
		}
	}
	assertWorkerQuiet(t, worker)
}

func TestFixedQueueCapacityRejectsAllAdmissionPathsAtomically(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "bounded input", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Represent a saturated, explicitly paused lane without thousands of disk
	// writes or any executable fixture work. Every tested admission is public.
	engine.mu.Lock()
	engine.paused = true
	engine.queue = make([]string, MaxQueue)
	for index := range engine.queue {
		engine.queue[index] = fmt.Sprintf("held-queue-owner-%d", index)
	}
	engine.mu.Unlock()
	before := persistence.Snapshot()
	if err := engine.Enqueue(context.Background(), message); !errors.Is(err, runtime.ErrBackpressure) {
		t.Fatal("queue admission exceeded its fixed lane capacity", err)
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "extra public input"}); !errors.Is(err, runtime.ErrBackpressure) {
		t.Fatal("public admission persisted a request it could not queue", err)
	}
	if _, err := engine.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{}); !errors.Is(err, runtime.ErrBackpressure) {
		t.Fatal("resume exceeded the shared queue capacity", err)
	}
	if !reflect.DeepEqual(before, persistence.Snapshot()) || len(engine.Snapshot().Queue) != MaxQueue || !engine.Snapshot().Executor.Paused {
		t.Fatal("backpressure discarded queued owners, changed messages or cleared the user's pause")
	}
	assertWorkerQuiet(t, worker)
}

func TestSubscriptionMediaAndMaintenanceCannotStartNewQueuedExecution(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "subscription-queue-call", Provider: "subscription"}}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "wait for voice ownership"})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal("voice-blocked input was not preserved", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.PauseReason.Value != "voice-call" || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("native voice media allowed a parallel task turn", err)
	}
	if _, err := engine.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{}); !errors.Is(err, ErrBusy) {
		t.Fatal("resume bypassed native media ownership", err)
	}
	assertWorkerQuiet(t, worker)
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(context.Background(), message); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine queued execution", err)
	}
}
