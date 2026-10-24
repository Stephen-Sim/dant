package work

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const returnedControlClientID = "7367d968-5a10-4bb4-a455-7a6567830261"

func returnedControlFixture(t *testing.T) (*Engine, *store.Store, *fakeWorker) {
	t.Helper()
	engine, persistence, worker := engineFixture(t)
	if err := engine.Acquire(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := engine.Release(); err != nil {
		t.Fatal(err)
	}
	if snapshot := engine.Snapshot(); !snapshot.Executor.Paused || !snapshot.Executor.ConfirmedStopped || snapshot.Takeover || snapshot.Acquiring {
		t.Fatal("returning control changed work admission before a new human request")
	}
	assertWorkerQuiet(t, worker)
	return engine, persistence, worker
}

func admitReturnedControlInput(t *testing.T, engine *Engine, persistence *store.Store, source string) (*contracts.ChatMessage, error) {
	t.Helper()
	input := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic new human instruction"}
	if source == "web" {
		input.ClientMessageID = returnedControlClientID
		receipt, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), input)
		return receipt.Message, err
	}
	input.ClientMessageID = "tg:returned-control:1"
	input.Source = contracts.RawObject{"type": raw("telegram"), "updateId": raw(1)}
	input.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft))
	message, err := persistence.Add(t.Context(), input)
	if err != nil {
		return nil, err
	}
	return message, engine.AdmitExternalMessage(t.Context(), persistence.ConversationID(), message)
}

func TestReturnedControlNewHumanInputStartsOnlyItsOwnExecution(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		t.Run(source, func(t *testing.T) {
			engine, persistence, worker := returnedControlFixture(t)
			original, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic old paused request",
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusConfirmed),
				TurnID:     contracts.Some("old-human-control-turn"), PauseReason: contracts.Some("human-control"),
			})
			if err != nil {
				t.Fatal(err)
			}
			unknown, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic old unconfirmed request",
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
				TurnID: contracts.Some("old-unconfirmed-turn"), PauseReason: contracts.Some("executor-disconnected"),
			})
			if err != nil {
				t.Fatal(err)
			}
			plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "Synthetic retained unfinished step", Status: contracts.PlanStepStatusPending}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			work, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{
				TurnID: original.TurnID.Value, MessageID: original.ID, Source: "chat", Title: "Synthetic old work", Plan: &plan,
			})
			if err != nil {
				t.Fatal(err)
			}
			work, err = persistence.UpdateRegisteredWork(t.Context(), original.TurnID.Value, store.UpdateRegisteredWorkOptions{
				Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				retained, err := store.FindWork(state, work.ID)
				if err == nil {
					retained.PauseReason = contracts.Some("human-control")
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
			beforeState := persistence.Snapshot()
			work, _ = store.FindWork(&beforeState, work.ID)
			original, _ = persistence.Message(original.ID)
			unknown, _ = persistence.Message(unknown.ID)
			beforeWork, _ := json.Marshal(work)
			beforeOriginal, _ := json.Marshal(original)
			beforeUnknown, _ := json.Marshal(unknown)

			message, err := admitReturnedControlInput(t, engine, persistence, source)
			if err != nil || message == nil {
				t.Fatal("new human input was not admitted", err)
			}
			acceptThreadAndTurn(t, worker, "returned-control-new-turn")
			owner := waitToolScope(t, engine, "returned-control-new-turn")
			snapshot := engine.Snapshot()
			if !owner.IsCurrent() || snapshot.Executor.Paused || snapshot.Active == nil || snapshot.Active.MessageID.Value != message.ID || len(snapshot.Active.MessageIDs) != 1 {
				t.Fatal("new input did not own its acknowledged execution")
			}
			for id, before := range map[string][]byte{original.ID: beforeOriginal, unknown.ID: beforeUnknown} {
				retained, err := persistence.Message(id)
				after, marshalErr := json.Marshal(retained)
				if err != nil || marshalErr != nil || string(after) != string(before) {
					t.Fatal("new input changed earlier paused or unknown work", err, marshalErr)
				}
			}
			afterState := persistence.Snapshot()
			retained, err := store.FindWork(&afterState, work.ID)
			afterWork, marshalErr := json.Marshal(retained)
			if err != nil || marshalErr != nil || string(afterWork) != string(beforeWork) {
				t.Fatal("a new human input resumed or rewrote old durable work", err, marshalErr)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestReturnedControlCannotUnlockUnconfirmedOrStillOwnedExecution(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		for _, scenario := range []string{"human-control", "acquiring", "reserved-control", "unconfirmed-stop", "inherited-stop", "preparing-thread", "active-preparing", "active-unknown", "existing-queue", "pending-followup", "call", "call-reservation", "user-paused", "executor-disconnected", "submission-unknown", "executor-stop-unconfirmed"} {
			t.Run(source+"/"+scenario, func(t *testing.T) {
				engine, persistence, worker := returnedControlFixture(t)
				engine.mu.Lock()
				switch scenario {
				case "human-control":
					engine.takeover = true
				case "acquiring":
					engine.acquiring = true
				case "reserved-control":
					engine.computerAcquireReserved = true
				case "unconfirmed-stop":
					engine.confirmedStopped = false
				case "inherited-stop":
					engine.inheritedStopFence = true
				case "preparing-thread":
					engine.openingThread = true
				case "active-preparing", "active-unknown":
					engine.active = &execution{messageID: "retained-active", unknown: scenario == "active-unknown"}
					defer func() {
						engine.mu.Lock()
						engine.active = nil
						engine.mu.Unlock()
					}()
				case "existing-queue":
					engine.queue = []string{"retained-queued-request"}
				case "pending-followup":
					engine.pendingFollowups["retained-followup"] = true
				case "call":
					engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "fixture-call", Provider: "api"}}
				case "call-reservation":
					engine.callReservation = &CallStartReservation{Token: "fixture-reservation"}
				default:
					engine.pauseReason = scenario
				}
				engine.mu.Unlock()
				beforeQueue := len(engine.Snapshot().Queue)
				message, err := admitReturnedControlInput(t, engine, persistence, source)
				if err != nil || message == nil {
					t.Fatal(err)
				}
				stored, err := persistence.Message(message.ID)
				if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.Submission.Value == contracts.SubmissionStatusConfirmed || !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != beforeQueue {
					t.Fatal("new human input bypassed an existing safety owner", scenario, err)
				}
				assertWorkerQuiet(t, worker)
			})
		}
	}
}

func TestReturnedControlCannotUnlockAnUnavailableExecutor(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		for _, scenario := range []string{"offline", "maintenance", "closed"} {
			t.Run(source+"/"+scenario, func(t *testing.T) {
				engine, persistence, worker := returnedControlFixture(t)
				if scenario == "offline" {
					engine.worker = unavailableVoiceWorker{fakeWorker: worker}
				} else if scenario == "maintenance" {
					engine.mu.Lock()
					engine.maintenance = true
					engine.mu.Unlock()
				} else if err := engine.Close(); err != nil {
					t.Fatal(err)
				}
				message, err := admitReturnedControlInput(t, engine, persistence, source)
				if scenario == "offline" && source == "telegram" {
					if err != nil || message == nil {
						t.Fatal("offline integration input lost its paused persistence", err)
					}
				} else {
					expected := ErrClosed
					if scenario == "offline" {
						expected = runtime.ErrDisconnected
					}
					if !errors.Is(err, expected) {
						t.Fatal("unavailable executor accepted new execution", scenario, err)
					}
				}
				if !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
					t.Fatal("unavailable executor cleared the human-control safety stop")
				}
				assertWorkerQuiet(t, worker)
			})
		}
	}
}

func TestReturnedControlPreservesSafetyStopsThatPredateHumanControl(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		for _, reason := range []string{"user-paused", "executor-disconnected", "submission-unknown", "executor-stop-unconfirmed", "voice-call", ""} {
			t.Run(source+"/"+reason, func(t *testing.T) {
				engine, persistence, worker := engineFixture(t)
				if reason == "user-paused" {
					if err := engine.Pause(t.Context()); err != nil {
						t.Fatal(err)
					}
				} else {
					engine.mu.Lock()
					engine.paused = true
					engine.pauseReason = reason
					engine.mu.Unlock()
				}
				if err := engine.Acquire(t.Context()); err != nil {
					t.Fatal(err)
				}
				if err := engine.Release(); err != nil {
					t.Fatal(err)
				}
				message, err := admitReturnedControlInput(t, engine, persistence, source)
				if err != nil || message == nil {
					t.Fatal(err)
				}
				stored, err := persistence.Message(message.ID)
				expected := reason
				if expected == "" {
					expected = "submission-unknown"
				}
				if err != nil || stored.PauseReason.Value != expected || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
					t.Fatal("taking and returning control erased a prior safety stop", reason, err)
				}
				assertWorkerQuiet(t, worker)
			})
		}
	}
}

func TestReturnedControlIgnoresSchedulerAndPreviouslyAdmittedRetries(t *testing.T) {
	for _, scenario := range []string{"scheduler", "web-duplicate", "telegram-paused", "telegram-queued"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := returnedControlFixture(t)
			input := &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic retained request", ClientMessageID: returnedControlClientID,
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted), PauseReason: contracts.Some("human-control"),
			}
			if scenario == "telegram-paused" || scenario == "telegram-queued" {
				input.ClientMessageID = "tg:returned-control:old"
				input.Source = contracts.RawObject{"type": raw("telegram")}
				if scenario == "telegram-queued" {
					input.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))
				}
			}
			message, err := persistence.Add(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "scheduler":
				err = engine.Enqueue(t.Context(), message)
			case "web-duplicate":
				var receipt AdmissionReceipt
				receipt, err = engine.AdmitMessage(t.Context(), persistence.ConversationID(), input)
				if !receipt.Existing {
					t.Fatal("idempotent input lost its retained identity")
				}
			default:
				err = engine.AdmitExternalMessage(t.Context(), persistence.ConversationID(), message)
				if scenario == "telegram-paused" && errors.Is(err, ErrPaused) {
					err = nil
				}
			}
			if err != nil || !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("non-new input unlocked paused work", scenario, err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestReturnedControlExternalDraftCannotClearAnUnconfirmedSubmission(t *testing.T) {
	for _, scenario := range []string{"unknown-outcome", "unknown-submission", "submitting", "confirmed", "old-turn"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := returnedControlFixture(t)
			input := &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic retained external draft", ClientMessageID: "tg:returned-control:unconfirmed",
				Source: contracts.RawObject{"type": raw("telegram")}, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft)),
			}
			switch scenario {
			case "unknown-outcome":
				input.UnknownOutcome = true
			case "unknown-submission":
				input.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			case "submitting":
				input.Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
			case "confirmed":
				input.Submission = contracts.Some(contracts.SubmissionStatusConfirmed)
			case "old-turn":
				input.TurnID = contracts.Some("retained-confirmed-turn")
			}
			message, err := persistence.Add(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(message)
			err = engine.AdmitExternalMessage(t.Context(), persistence.ConversationID(), message)
			if scenario == "confirmed" || scenario == "old-turn" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, ErrUnknown) {
				t.Fatal("unconfirmed external draft was accepted", scenario, err)
			}
			retained, err := persistence.Message(message.ID)
			after, marshalErr := json.Marshal(retained)
			if err != nil || marshalErr != nil || string(before) != string(after) || !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("external draft changed prior submission ownership", err, marshalErr)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestReturnedControlAdmissionFailureDoesNotUnlockWork(t *testing.T) {
	for _, scenario := range []string{"web-persistence", "telegram-persistence", "stale-conversation", "stop-fence"} {
		t.Run(scenario, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.Messages) > 0 }}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			if err := engine.Acquire(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := engine.Release(); err != nil {
				t.Fatal(err)
			}
			source := "web"
			var err error
			if scenario == "stop-fence" {
				err = persistence.Mutate(t.Context(), func(state *contracts.State) error {
					if state.Extra == nil {
						state.Extra = contracts.RawObject{}
					}
					state.Extra[executorStopFenceKey] = raw(true)
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "stale-conversation" {
				_, err = engine.AdmitMessage(t.Context(), "another-conversation", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic stale input"})
			} else {
				if scenario == "telegram-persistence" {
					source = "telegram"
					fault.match = func(state contracts.State) bool {
						for _, message := range state.Messages {
							if message.Status.Value == contracts.MessageStatus(contracts.TaskStatusQueued) {
								return true
							}
						}
						return false
					}
				}
				if scenario == "web-persistence" || scenario == "telegram-persistence" {
					fault.armed.Store(true)
				}
				_, err = admitReturnedControlInput(t, engine, persistence, source)
			}
			if err == nil || !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("failed new-input persistence unlocked execution", scenario, err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
