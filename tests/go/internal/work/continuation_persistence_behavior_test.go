package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestContinuationPersistenceFailureNeverReusesAnUnconfirmedAcknowledgement(t *testing.T) {
	for _, phase := range []string{"submission", "acknowledgement", "settlement"} {
		t.Run(phase, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				if len(state.WorkTasks) != 1 || state.WorkTasks[0].Continuation == nil {
					return false
				}
				dispatch := state.WorkTasks[0].Continuation.Dispatch
				switch phase {
				case "submission":
					return dispatch != nil && dispatch.Phase == contracts.ContinuationDispatchPhaseSubmitting
				case "acknowledgement":
					return dispatch != nil && dispatch.Phase == contracts.ContinuationDispatchPhaseAcknowledged
				default:
					return dispatch == nil
				}
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			workID, fromTurn := savedUnfinished(t, persistence)
			fault.armed.Store(true)
			done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
			read := nextRequest(t, worker, "thread/read")
			thread := continuationBehaviorThread(fromTurn)
			if phase == "settlement" {
				thread["status"] = raw(contracts.RawObject{"type": raw("active")})
			}
			if phase == "settlement" {
				replyContinuationMetadata(t, read, thread)
			} else {
				replyContinuationInventory(t, worker, read, thread)
			}
			if phase == "acknowledgement" {
				start := nextRequest(t, worker, "turn/start")
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("observed-unpersisted-turn")})}}
			}
			if err := awaitWorkAction(t, done); !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("continuation persistence failure was reported as successful admission", err)
			}
			state := persistence.Snapshot()
			record, err := store.FindWork(&state, workID)
			if err != nil || record.TurnID != fromTurn || engine.Snapshot().Active != nil {
				t.Fatal("failed continuation persistence invented a new authoritative turn", err)
			}
			switch phase {
			case "submission":
				if record.Status != contracts.WorkStatusContinuing || record.Continuation.Dispatch != nil || engine.Snapshot().Executor.Paused {
					t.Fatal("failed pre-dispatch save became an unknown external action")
				}
			case "acknowledgement":
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch == nil || !engine.Snapshot().Executor.Paused {
					t.Fatal("unpersisted start acknowledgement was made replayable")
				}
			default:
				if record.Continuation.Dispatch == nil || !engine.Snapshot().Executor.Paused {
					t.Fatal("failed settlement discarded its last durable admission fence")
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

type continuationBaselineFailure struct{}

func (continuationBaselineFailure) CaptureBaseline(context.Context, string) (json.RawMessage, error) {
	return nil, errors.New("isolated_output_baseline_failure")
}

func (continuationBaselineFailure) Archive(context.Context, string, string, json.RawMessage) ([]contracts.Attachment, error) {
	return nil, errors.New("unexpected_output_archive")
}

func TestContinuationInputIncludesOnlyScopedMemoryAndStopsOnPreparationFailures(t *testing.T) {
	for _, scenario := range []string{"scoped-memory", "memory-error", "baseline-error"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			failure := errors.New("isolated_continuation_memory_failure")
			engine.options.Memory = ReferenceMemoryFunc(func(_ context.Context, query, conversationID, id string) (string, error) {
				if id != workID || conversationID != persistence.ConversationID() || !strings.Contains(query, "entrusted work") || !strings.Contains(query, "verify actual result") {
					t.Fatal("continuation memory query lost its task title or remaining step scope")
				}
				if scenario == "memory-error" {
					return "", failure
				}
				return "quoted scoped memory", nil
			})
			if scenario == "baseline-error" {
				engine.options.Deliverables = continuationBaselineFailure{}
			}
			done := beginContinuationBehavior(t, engine, worker, workID, fromTurn)
			read := nextRequest(t, worker, "thread/read")
			replyContinuationInventory(t, worker, read, continuationBehaviorThread(fromTurn))
			if scenario == "scoped-memory" {
				start := nextRequest(t, worker, "turn/start")
				if !strings.Contains(string(start.params["input"]), "quoted scoped memory") || !strings.Contains(string(start.params["input"]), workID) {
					t.Fatal("continuation discarded its bounded quoted memory or work identity")
				}
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("memory-scoped-turn")})}}
				if err := awaitWorkAction(t, done); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := awaitWorkAction(t, done); err == nil {
					t.Fatal("failed preparation still submitted continuation")
				}
				state := persistence.Snapshot()
				if state.WorkTasks[0].TurnID != fromTurn || state.WorkTasks[0].Continuation.Dispatch != nil || engine.Snapshot().Executor.Paused {
					t.Fatal("known pre-submit preparation failure changed the previous owner")
				}
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
