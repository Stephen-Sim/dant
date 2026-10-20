package work

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestQueuedHumanTaskRepliesUseTheSingleContinuationLaneAndRetainKnownRejections(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "read-rejected", true: "acknowledged"}[accepted], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			receipt, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "continue only the requested adjustment", ClientMessageID: admissionClientID,
				WorkReply: &contracts.WorkReplyTarget{WorkID: workID, TurnID: fromTurn, ConversationID: persistence.ConversationID()},
			})
			if err != nil || !receipt.Queued || receipt.SteerTurnID != "" {
				t.Fatal("inactive explicit task reply bypassed the existing queue", err)
			}
			resume := nextRequest(t, worker, "thread/resume")
			resume.result <- fakeResponse{value: contracts.RawObject{}}
			read := nextRequest(t, worker, "thread/read")
			thread := continuationBehaviorThread(fromTurn)
			if !accepted {
				thread["status"] = raw(contracts.RawObject{"type": raw("active")})
			}
			read.result <- fakeResponse{value: contracts.RawObject{"thread": raw(thread)}}
			if accepted {
				start := nextRequest(t, worker, "turn/start")
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("queued-human-continuation")})}}
				owner := waitToolScope(t, engine, "queued-human-continuation")
				if owner.WorkID != workID || owner.MessageID != receipt.Message.ID {
					t.Fatal("queued human reply adopted another task or input identity")
				}
			} else {
				waitSnapshot(t, engine, func(state Snapshot) bool { return state.Active == nil && len(state.Queue) == 0 })
				// The pump's local pause annotation follows the continuation's
				// terminal change signal, so synchronize on its persisted write.
				changes, unsubscribe := persistence.Subscribe()
				defer unsubscribe()
				deadline := time.NewTimer(10 * time.Second)
				defer deadline.Stop()
				for {
					stored, err := persistence.Message(receipt.Message.ID)
					if err != nil {
						t.Fatal(err)
					}
					if stored.PauseReason.Value == "work-reply-unavailable" {
						if stored.UnknownOutcome || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
							t.Fatal("known unsubmitted reply was changed into an uncertain external action")
						}
						break
					}
					select {
					case <-changes:
					case <-deadline.C:
						t.Fatal("rejected queued reply did not reach its persisted pause annotation")
					}
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestPersistedTaskReplyQueueAdmissionSteersItsExactAlreadyActiveTurnOnlyOnce(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "persisted-reply-turn")
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("existing owner", contracts.PlanStepStatusPending), owner); err != nil {
		t.Fatal(err)
	}
	workID := persistence.Snapshot().WorkTasks[0].ID
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "follow-up to this task", WorkID: workID,
		WorkReply: &contracts.WorkReplyTarget{WorkID: workID, TurnID: owner.TurnID, ConversationID: owner.ConversationID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	steer := nextRequest(t, worker, "turn/steer")
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal("duplicate pending task reply lost its accepted identity", err)
	}
	steer.result <- fakeResponse{value: contracts.RawObject{}}
	waitSnapshot(t, engine, func(state Snapshot) bool { return len(state.PendingFollowups) == 0 })
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.TurnID.Value != owner.TurnID || stored.Submission.Value != contracts.SubmissionStatusConfirmed || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("persisted reply started a second owner or lost its steer acknowledgement", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestQueuedSchedulesCannotStartBesideLiveMediaAndRemainExplicitlyPausable(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "schedule-media-call", Provider: "api"}}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "schedule-current-turn")
	scheduled, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "scheduled isolated work", Scheduled: true})
	if err != nil || engine.Enqueue(context.Background(), scheduled) != nil {
		t.Fatal("scheduled work was not durably queued", err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if snapshot := engine.Snapshot(); snapshot.Active != nil || len(snapshot.Queue) != 1 || snapshot.Queue[0] != scheduled.ID {
		t.Fatal("schedule ran while its conversation still had live media")
	}
	if err := engine.Pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := persistence.Message(scheduled.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("explicit pause discarded or executed blocked scheduled work", err)
	}
	if _, err := engine.ContinueRegisteredWork(context.Background(), "missing", ContinueOptions{}); !errors.Is(err, ErrBusy) {
		t.Fatal("explicit pause allowed an automatic continuation", err)
	}
	assertWorkerQuiet(t, worker)
}
