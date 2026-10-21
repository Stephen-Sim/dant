package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type failedPauseCalls struct {
	*admissionCalls
	failure error
}

func (calls failedPauseCalls) PauseWork(context.Context) error { return calls.failure }

func TestPauseAndComputerAcquireReportQueuedWriteAndMediaFailures(t *testing.T) {
	for _, acquire := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit pause", true: "computer acquire"}[acquire], func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				return len(state.Messages) > 0 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusPaused)
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Queued synthetic input", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))})
			if err != nil {
				t.Fatal(err)
			}
			engine.mu.Lock()
			engine.queue = []string{message.ID}
			engine.mu.Unlock()
			fault.armed.Store(true)
			if acquire {
				err = engine.BeginComputerAcquire()
			} else {
				err = engine.Pause(t.Context())
			}
			if !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("failed queued state write was reported as a confirmed pause", err)
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusQueued) || acquire && (engine.Snapshot().Acquiring || len(engine.Snapshot().Queue) != 1) {
				t.Fatal("failed acquire retained a phantom reservation or changed persisted input", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
	engine, _, worker := engineFixture(t)
	failure := errors.New("isolated media pause failure")
	engine.options.Calls = failedPauseCalls{admissionCalls: &admissionCalls{call: contracts.Call{ID: "failed-media-pause", Provider: "api"}}, failure: failure}
	if err := engine.Pause(t.Context()); !errors.Is(err, failure) || !engine.Snapshot().Executor.Paused {
		t.Fatal("media pause failure cleared explicit user pause or claimed success", err)
	}
	if err := engine.BeginComputerAcquire(); !errors.Is(err, ErrBusy) {
		t.Fatal("computer acquire crossed a still-owned media session", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestInterruptionShutdownPreservesItsUnconfirmedTaskAndRevokesItsOwner(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	ended := make(chan string, 1)
	engine.options.OwnerEnded = func(id string) { ended <- id }
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "interrupt-shutdown-turn")
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- engine.interrupt(t.Context(), active) }()
	request := nextRequest(t, worker, "turn/interrupt")
	request.result <- fakeResponse{value: contracts.RawObject{}}
	if id := <-ended; id != owner.TurnID {
		t.Fatal("interruption revoked another turn's owner")
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); !errors.Is(err, ErrClosed) {
		t.Fatal("engine shutdown fabricated independent stop confirmation", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value == contracts.MessageStatus(contracts.TaskStatusCompleted) || stored.Submission.Value != contracts.SubmissionStatusConfirmed || owner.IsCurrent() {
		t.Fatal("unconfirmed interruption lost the task or retained execution capability", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestResumeRejectsOldRegisteredTurnsAndUnsettledMediaInputs(t *testing.T) {
	for _, scenario := range []string{"offline", "live media input", "old registered turn"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Retained input", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted)})
			if err != nil {
				t.Fatal(err)
			}
			var want error
			switch scenario {
			case "offline":
				engine.worker = unavailableVoiceWorker{fakeWorker: worker}
			case "live media input":
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "retained-input-call", Provider: "api"}}
				if _, err := persistence.Update(t.Context(), message.ID, patch(contracts.RawObject{"voiceCallId": raw("retained-input-call")})); err != nil {
					t.Fatal(err)
				}
				want = ErrBusy
			case "old registered turn":
				record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "newer-registered-turn", Source: "chat", Title: "Preserved current work", Observed: true})
				if err != nil {
					t.Fatal(err)
				}
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					input, err := store.FindMessage(state, message.ID)
					if err == nil {
						input.WorkID, input.TurnID = record.ID, contracts.Some("older-input-turn")
					}
					return err
				}); err != nil {
					t.Fatal(err)
				}
				want = ErrStaleOwner
			}
			before := persistence.Revision()
			_, err = engine.ResumePaused(t.Context(), []string{message.ID}, ResumeOptions{})
			if err == nil || want != nil && !errors.Is(err, want) || persistence.Revision() != before || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("resume accepted an unavailable executor, stale turn or unsettled media input", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
