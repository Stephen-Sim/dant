package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func assertPausedAdmissionReason(t *testing.T, engine *Engine, persistence *store.Store, worker *fakeWorker, reason string) {
	t.Helper()
	queued, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic queued input"})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(t.Context(), queued); err != nil {
		t.Fatal(err)
	}
	receipt, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic browser input"})
	if err != nil || receipt.Message == nil || receipt.Queued || receipt.CallID != "" || receipt.SteerTurnID != "" {
		t.Fatal("blocked browser input was routed to an execution owner", err)
	}
	for _, id := range []string{queued.ID, receipt.Message.ID} {
		message, err := persistence.Message(id)
		if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || message.PauseReason.Value != reason {
			t.Fatal("blocked input lost the actual pause cause", reason, message, err)
		}
		if message.UnknownOutcome || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting || message.TurnID.Value != "" {
			t.Fatal("a blocked new input inherited an earlier execution's unknown outcome")
		}
	}
	if len(engine.Snapshot().Queue) != 0 || engine.Snapshot().Active != nil {
		t.Fatal("pause attribution admitted new execution")
	}
	assertWorkerQuiet(t, worker)
}

func TestNewMessagesDistinguishExplicitPauseAndHumanControl(t *testing.T) {
	for _, scenario := range []string{"explicit-pause", "acquiring", "takeover", "unexplained-safety-stop"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			reason := "human-control"
			switch scenario {
			case "explicit-pause":
				reason = "user-paused"
				if err := engine.Pause(t.Context()); err != nil {
					t.Fatal(err)
				}
			case "acquiring":
				if err := engine.BeginComputerAcquire(); err != nil {
					t.Fatal(err)
				}
			case "unexplained-safety-stop":
				// A safety stop with no retained diagnostic must remain unknown;
				// the browser must not invent an explicit human pause.
				reason = "submission-unknown"
				engine.mu.Lock()
				engine.paused = true
				engine.mu.Unlock()
			default:
				if err := engine.Acquire(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			assertPausedAdmissionReason(t, engine, persistence, worker, reason)
		})
	}
}

func TestPauseCauseTracksTheExactExecutionAcrossPreparationAndTerminal(t *testing.T) {
	for _, submitted := range []bool{false, true} {
		for _, acquire := range []bool{false, true} {
			name := "preparing"
			if submitted {
				name = "submitted"
			}
			reason := "user-paused"
			if acquire {
				reason = "human-control"
			}
			t.Run(name+"/"+reason, func(t *testing.T) {
				engine, persistence, worker := engineFixture(t)
				var message *contracts.ChatMessage
				if submitted {
					message, _ = beginBehaviorTurn(t, engine, persistence, worker, "owned-pause-reason-turn")
				} else {
					var err error
					message, err = persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic preparing input"})
					if err != nil {
						t.Fatal(err)
					}
					if err := engine.Enqueue(t.Context(), message); err != nil {
						t.Fatal(err)
					}
					_ = nextRequest(t, worker, "thread/start")
				}
				result := make(chan error, 1)
				go func() {
					if acquire {
						result <- engine.Acquire(t.Context())
					} else {
						result <- engine.Pause(t.Context())
					}
				}()
				if submitted {
					request := nextRequest(t, worker, "turn/interrupt")
					if eventString(request.params, "turnId") != "owned-pause-reason-turn" {
						t.Fatal("pause attribution changed the interrupted execution identity")
					}
					request.result <- fakeResponse{value: contracts.RawObject{}}
					if err := engine.Handle(t.Context(), terminal("owned-pause-reason-turn", "interrupted")); err != nil {
						t.Fatal(err)
					}
				}
				if err := awaitWorkAction(t, result); err != nil {
					t.Fatal(err)
				}
				stored, err := persistence.Message(message.ID)
				if err != nil || stored.UnknownOutcome || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.PauseReason.Value != reason {
					t.Fatal("the owned execution lost its captured pause cause", reason, err)
				}
				if !submitted && stored.Submission.Value != contracts.SubmissionStatusNotSubmitted {
					t.Fatal("preparation interruption invented a submitted execution")
				}
				assertPausedAdmissionReason(t, engine, persistence, worker, reason)
			})
		}
	}
}

func TestNewMessagesRetainDisconnectCauseWithoutReplayingUnknownWork(t *testing.T) {
	engine, persistence, worker := observedEventFixture(t)
	original, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "pause-reason-disconnect-turn")
	close(worker.events)
	waitEventRetirement(t, worker)
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && snapshot.Executor.Paused })
	if err := engine.ConnectionTransaction(t.Context(), true, func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	assertPausedAdmissionReason(t, engine, persistence, worker.fakeWorker, "executor-disconnected")
	if _, err := engine.ResumePaused(t.Context(), []string{original.ID}, ResumeOptions{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("attributing a disconnect authorized replay of its unknown work", err)
	}
	if err := engine.Pause(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertPausedAdmissionReason(t, engine, persistence, worker.fakeWorker, "user-paused")
	stored, err := persistence.Message(original.ID)
	if err != nil || !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || stored.TurnID.Value != owner.TurnID || stored.PauseReason.Value != "executor-disconnected" {
		t.Fatal("new input attribution rewrote the original unknown execution", err)
	}
}

func TestLateIdleDisconnectDoesNotRelabelAnExplicitPause(t *testing.T) {
	engine, persistence, worker := observedEventFixture(t)
	if err := engine.Pause(t.Context()); err != nil {
		t.Fatal(err)
	}
	openNativeBehaviorThread(t, engine, worker.fakeWorker)
	close(worker.events)
	waitEventRetirement(t, worker)
	assertPausedAdmissionReason(t, engine, persistence, worker.fakeWorker, "user-paused")
}

func TestRestartedUnknownWorkRetainsOnlyItsOwnedPersistedPauseCause(t *testing.T) {
	for _, scenario := range []string{"owned-message", "work-record", "unrecognized", "continuation", "known-owned-history"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			original, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic retained owner", TurnID: contracts.Some("retained-pause-turn"),
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "Synthetic remaining verification", Status: contracts.PlanStepStatusPending}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: original.TurnID.Value, MessageID: original.ID, Title: "Synthetic retained work", Source: "chat", Plan: &plan})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Unrelated historical input", PauseReason: contracts.Some("user-paused")}); err != nil {
				t.Fatal(err)
			}
			reason := "submission-unknown"
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				work, err := store.FindWork(state, record.ID)
				if err != nil {
					return err
				}
				work.Status = contracts.WorkStatusUnknown
				work.UnknownOutcome = true
				message, err := store.FindMessage(state, original.ID)
				if err != nil {
					return err
				}
				switch scenario {
				case "owned-message":
					reason = "executor-disconnected"
					message.PauseReason = contracts.Some(reason)
				case "work-record":
					reason = "continuation-unconfirmed"
					work.PauseReason = contracts.Some(reason)
				case "unrecognized":
					work.PauseReason = contracts.Some("unrecognized-private-reason")
				case "continuation", "known-owned-history":
					reason = "continuation-unconfirmed"
					work.Continuation = &contracts.WorkContinuation{Invalid: true}
					if scenario == "known-owned-history" {
						message.UnknownOutcome = false
						message.Submission = contracts.Some(contracts.SubmissionStatusConfirmed)
						message.PauseReason = contracts.Some("user-paused")
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			directory := persistence.Directory()
			persistence.Close()
			reopened, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			restarted, err := New(t.Context(), reopened, worker, Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			assertPausedAdmissionReason(t, restarted, reopened, worker, reason)
			stored, err := reopened.Message(original.ID)
			unknown := scenario != "known-owned-history"
			submission := contracts.SubmissionStatusUnknown
			if !unknown {
				submission = contracts.SubmissionStatusConfirmed
			}
			if err != nil || stored.UnknownOutcome != unknown || stored.Submission.Value != submission {
				t.Fatal("restart attribution changed the retained submission outcome", err)
			}
		})
	}
}
