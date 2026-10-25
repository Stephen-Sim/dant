package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func selectedPausedFixture(t *testing.T) (*Engine, *store.Store, *fakeWorker, string, string) {
	t.Helper()
	engine, persistence, worker := engineFixture(t)
	id, turn := savedUnfinished(t, persistence)
	if err := engine.Pause(t.Context()); err != nil {
		t.Fatal(err)
	}
	return engine, persistence, worker, id, turn
}

func selectedResumeRead(t *testing.T, engine *Engine, worker *fakeWorker, id, turn string) (fakeRequest, <-chan error) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := engine.ResumeProgress(t.Context(), id, store.ProgressWork, turn)
		done <- err
	}()
	request := nextRequest(t, worker, "thread/resume")
	request.result <- fakeResponse{value: contracts.RawObject{}}
	return nextRequest(t, worker, "thread/read"), done
}

func selectedReadResponse(turn string) fakeResponse {
	return fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{
		"id": raw("thread-fixture"), "status": raw(contracts.RawObject{"type": raw("idle")}),
		"turns": raw([]contracts.RawObject{{"id": raw(turn), "status": raw("interrupted")}}),
	})}}
}

func TestSelectedResumeSameThreadHistoricalTurnRequiresFreshTerminalMembership(t *testing.T) {
	for _, present := range []bool{false, true} {
		t.Run(map[bool]string{false: "old-turn-missing", true: "old-turn-terminal"}[present], func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			old, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "unresolved historical synthetic action",
				Time: contracts.Some(float64(1)), ReceivedAt: contracts.Null[float64](), QueuedAt: contracts.Some(float64(2)),
				ExecutorConfirmedAt: contracts.Some(float64(3)), ExecutionEndedAt: contracts.Null[float64](),
				TurnID: contracts.Some("older-detached-turn"), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusUnknown)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
				Extra: contracts.RawObject{"threadId": raw("thread-fixture")},
			})
			if err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(old)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			turns := []contracts.RawObject{{"id": raw(turn), "status": raw("interrupted")}}
			if present {
				turns = append(turns, contracts.RawObject{"id": raw("older-detached-turn"), "status": raw("completed")})
			}
			read.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{
				"id": raw("thread-fixture"), "status": raw(contracts.RawObject{"type": raw("idle")}), "turns": raw(turns),
			})}}
			if present {
				start := nextRequest(t, worker, "turn/start")
				start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("fresh-selected-terminal-proof")})}}
				if err := awaitWorkAction(t, done); err != nil {
					t.Fatal(err)
				}
				if err := engine.Handle(t.Context(), terminal("fresh-selected-terminal-proof", "completed")); err != nil {
					t.Fatal(err)
				}
			} else if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("missing same-thread historical turn permitted execution")
			}
			saved, _ := persistence.Message(old.ID)
			after, _ := json.Marshal(saved)
			if string(before) != string(after) || !saved.UnknownOutcome {
				t.Fatal("terminal execution proof falsely resolved the historical outcome")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeClaimOwnsDuplicateAndLateRequests(t *testing.T) {
	engine, persistence, worker, id, turn := selectedPausedFixture(t)
	read, done := selectedResumeRead(t, engine, worker, id, turn)
	state := persistence.Snapshot()
	record, _ := store.FindWork(&state, id)
	if record.Status != contracts.WorkStatusContinuing || record.Continuation == nil || record.Continuation.Dispatch == nil || record.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseClaimed {
		t.Fatal("resume performed RPC without a durable selected claim")
	}
	if _, err := engine.ResumeProgress(t.Context(), id, store.ProgressWork, turn); !errors.Is(err, ErrBusy) {
		t.Fatal("a duplicate acquired a second executor", err)
	}
	assertWorkerQuiet(t, worker)
	read.result <- selectedReadResponse(turn)
	start := nextRequest(t, worker, "turn/start")
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("selected-resumed-turn")})}}
	if err := awaitWorkAction(t, done); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(t.Context(), terminal("selected-resumed-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.ResumeProgress(t.Context(), id, store.ProgressWork, turn); err == nil {
		t.Fatal("late original card replayed the acknowledged new turn")
	}
	state = persistence.Snapshot()
	record, _ = store.FindWork(&state, id)
	if record.TurnID != "selected-resumed-turn" || record.Continuation.Attempts != 1 {
		t.Fatal("duplicate or late request changed the durable attempt")
	}
	assertWorkerQuiet(t, worker)
}

func TestSelectedResumeRefusesActiveSafetyFencesWithoutMutatingPausedWork(t *testing.T) {
	for _, scenario := range []string{"unconfirmed-stop", "inherited-stop", "takeover", "acquiring", "queue", "pending-request", "pending-followup", "reference", "maintenance", "call", "unknown-work", "wrong-runtime", "wrong-conversation"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			engine.mu.Lock()
			switch scenario {
			case "unconfirmed-stop":
				engine.confirmedStopped = false
			case "inherited-stop":
				engine.inheritedStopFence = true
			case "takeover":
				engine.takeover = true
			case "acquiring":
				engine.acquiring = true
			case "queue":
				engine.queue = []string{"other-message"}
			case "pending-request":
				engine.pendingRequests["other-request"] = runtime.Event{}
			case "pending-followup":
				engine.pendingFollowups["other-message"] = true
			case "reference":
				engine.referencePending = 1
			case "maintenance":
				engine.maintenance = true
			case "call":
				engine.callReservation = &CallStartReservation{CallID: "other-call", Provider: "api"}
			}
			engine.mu.Unlock()
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				switch scenario {
				case "unknown-work":
					state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{ID: "other-work", TurnID: "other-turn", Status: contracts.WorkStatusUnknown, UnknownOutcome: true})
				case "wrong-runtime":
					state.ThreadRuntime = contracts.Some("other-runtime")
				case "wrong-conversation":
					state.ThreadConversationID = "other-conversation"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(persistence.Snapshot())
			if _, err := engine.ResumeProgress(t.Context(), id, store.ProgressWork, turn); err == nil {
				t.Fatal("selected action bypassed an ownership or executor fence")
			}
			after, _ := json.Marshal(persistence.Snapshot())
			if string(before) != string(after) {
				t.Fatal("refused action changed persistent authority")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeRevalidatesAfterReadBeforeAnyTurnStart(t *testing.T) {
	for _, scenario := range []string{"busy-thread", "missing-terminal", "running-turn", "duplicate-turn", "runtime-changed", "conversation-changed", "takeover", "call-started", "new-unknown-message", "new-unknown-work"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			response := selectedReadResponse(turn)
			switch scenario {
			case "busy-thread":
				response = fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"active"},"turns":[]}`)}}
			case "missing-terminal":
				response = selectedReadResponse("different-turn")
			case "running-turn":
				response = fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[{"id":"previous-turn","status":"inProgress"}]}`)}}
			case "duplicate-turn":
				response = fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[{"id":"previous-turn","status":"completed"},{"id":"previous-turn","status":"completed"}]}`)}}
			case "runtime-changed", "conversation-changed", "new-unknown-message", "new-unknown-work":
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					switch scenario {
					case "runtime-changed":
						state.ThreadRuntime = contracts.Some("replacement-runtime")
					case "conversation-changed":
						state.ConversationID = "replacement-conversation"
					case "new-unknown-message":
						state.Messages = append(state.Messages, &contracts.ChatMessage{ID: "new-unknown", Role: contracts.RoleUser, Time: contracts.Some(engine.Timestamp()), Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true})
					case "new-unknown-work":
						state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{ID: store.UUID(), TurnID: "other-turn", Status: contracts.WorkStatusUnknown, UnknownOutcome: true})
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			case "takeover", "call-started":
				engine.mu.Lock()
				if scenario == "takeover" {
					engine.takeover = true
				} else {
					engine.callReservation = &CallStartReservation{CallID: "new-call", Provider: "api"}
				}
				engine.mu.Unlock()
			}
			read.result <- response
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("a stale or nonterminal thread admitted a turn")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

type selectedLateAckWorker struct {
	*fakeWorker
	acknowledged chan struct{}
	release      chan struct{}
}

func (worker *selectedLateAckWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	result, err := worker.fakeWorker.Request(ctx, method, params)
	if method == "turn/start" && err == nil {
		// The RPC already received the ACK; cancellation cannot erase that fact.
		close(worker.acknowledged)
		<-worker.release
	}
	return result, err
}

func TestSelectedResumePauseAcrossReceivedAckInterruptsOnlyTheAcknowledgedTurn(t *testing.T) {
	for _, stopFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed-stop", true: "unknown-stop"}[stopFails], func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			late := &selectedLateAckWorker{fakeWorker: worker, acknowledged: make(chan struct{}), release: make(chan struct{})}
			released := false
			defer func() {
				if !released {
					close(late.release)
				}
			}()
			engine.worker = late
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			read.result <- selectedReadResponse(turn)
			start := nextRequest(t, worker, "turn/start")
			start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("received-selected-ack")})}}
			select {
			case <-late.acknowledged:
			case <-time.After(10 * time.Second):
				t.Fatal("fixture did not receive the real RPC acknowledgement")
			}
			paused := make(chan error, 1)
			pauseContext, cancelPause := context.WithCancel(t.Context())
			defer cancelPause()
			go func() { paused <- engine.Pause(pauseContext) }()
			waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Executor.Paused })
			close(late.release)
			released = true
			interrupt := nextRequest(t, worker, "turn/interrupt")
			if eventString(interrupt.params, "turnId") != "received-selected-ack" || eventString(interrupt.params, "threadId") != "thread-fixture" {
				t.Fatal("stop targeted a retired turn instead of the received ACK")
			}
			if stopFails {
				interrupt.result <- fakeResponse{err: runtime.ErrDisconnected}
			} else {
				interrupt.result <- fakeResponse{value: contracts.RawObject{}}
				if err := engine.Handle(t.Context(), terminal("received-selected-ack", "interrupted")); err != nil {
					t.Fatal(err)
				}
			}
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("paused received ACK advertised ongoing resumed execution")
			}
			if stopFails {
				state := persistence.Snapshot()
				record, _ := store.FindWork(&state, id)
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown || engine.Snapshot().Executor.ConfirmedStopped {
					t.Fatal("unconfirmed interrupt lost its durable uncertainty fence")
				}
				cancelPause()
				if err := awaitWorkAction(t, paused); err == nil {
					t.Fatal("unconfirmed stop advertised successful pause")
				}
			} else if err := awaitWorkAction(t, paused); err != nil {
				t.Fatal(err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeKeepsKnownRejectionPausedAndUnknownSubmissionFenced(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "known-rejected", true: "unknown-submission"}[unknown], func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			read.result <- selectedReadResponse(turn)
			start := nextRequest(t, worker, "turn/start")
			start.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: unknown}}
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("rejected or uncertain start advertised success")
			}
			state := persistence.Snapshot()
			record, _ := store.FindWork(&state, id)
			if unknown {
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch == nil || record.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown || engine.Snapshot().Executor.ConfirmedStopped {
					t.Fatal("unknown submission became permission to replay")
				}
			} else if record.Status != contracts.WorkStatusPaused || record.Continuation.Dispatch != nil || !record.Continuation.NextAt.Null || !engine.Snapshot().Executor.Paused || !engine.Snapshot().Executor.ConfirmedStopped {
				t.Fatal("known rejection lost the paused, stopped selection")
			}
			if engine.CanContinueRegisteredWork() {
				t.Fatal("failed explicit action opened automatic continuation")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeCancellationAndShutdownJoinReadOnlyPreparation(t *testing.T) {
	for _, action := range []string{"caller-cancel", "explicit-pause", "shutdown"} {
		t.Run(action, func(t *testing.T) {
			engine, _, worker, id, turn := selectedPausedFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := engine.ResumeProgress(ctx, id, store.ProgressWork, turn)
				done <- err
			}()
			resume := nextRequest(t, worker, "thread/resume")
			resume.result <- fakeResponse{value: contracts.RawObject{}}
			_ = nextRequest(t, worker, "thread/read")
			switch action {
			case "caller-cancel":
				cancel()
			case "explicit-pause":
				if err := engine.Pause(t.Context()); err != nil {
					t.Fatal(err)
				}
			case "shutdown":
				closed := make(chan error, 1)
				go func() { closed <- engine.Close() }()
				select {
				case <-closed:
				case <-time.After(10 * time.Second):
					t.Fatal("shutdown did not join selected preparation")
				}
			}
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("cancelled preparation advertised a resumed turn")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeDisconnectionHasOneCleanupOwnerBeforeAcknowledgement(t *testing.T) {
	for _, submitted := range []bool{false, true} {
		t.Run(map[bool]string{false: "thread-read", true: "turn-start"}[submitted], func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			if submitted {
				read.result <- selectedReadResponse(turn)
				_ = nextRequest(t, worker, "turn/start")
			}
			disconnected := make(chan error, 1)
			go func() { engine.disconnected(); disconnected <- nil }()
			if err := awaitWorkAction(t, done); err == nil {
				t.Fatal("lost startup transport advertised a resumed task")
			}
			if err := awaitWorkAction(t, disconnected); err != nil {
				t.Fatal(err)
			}
			state := persistence.Snapshot()
			record, _ := store.FindWork(&state, id)
			if engine.Snapshot().Active != nil || !engine.Snapshot().Executor.Paused || engine.Snapshot().Executor.ConfirmedStopped {
				t.Fatal("disconnect retained an executor or invented stopped ownership")
			}
			if submitted {
				if record.Status != contracts.WorkStatusUnknown || record.Continuation.Dispatch == nil || record.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown {
					t.Fatal("disconnect replayed an unacknowledged start")
				}
			} else if record.Status != contracts.WorkStatusPaused || record.Continuation.Dispatch != nil || !record.Continuation.NextAt.Null {
				t.Fatal("read-only startup disconnection lost the paused selection")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSelectedResumeExplicitCancellationSettlesOnlyItsSelectedClaim(t *testing.T) {
	engine, persistence, worker, id, turn := selectedPausedFixture(t)
	_, done := selectedResumeRead(t, engine, worker, id, turn)
	if _, err := engine.CancelProgress(t.Context(), ProgressTarget{
		ID: id, Kind: "work", TurnID: contracts.Some(turn), ConversationID: persistence.ConversationID(),
	}, false); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); err == nil {
		t.Fatal("cancelled claim advertised resumed execution")
	}
	state := persistence.Snapshot()
	record, _ := store.FindWork(&state, id)
	if record.Status != contracts.WorkStatusCancelled || record.Continuation.Dispatch != nil || !record.Continuation.NextAt.Null {
		t.Fatal("selected cancellation left an automatic continuation")
	}
	assertWorkerQuiet(t, worker)
}
