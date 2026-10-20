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
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func beginBehaviorTurn(t *testing.T, engine *Engine, persistence *store.Store, worker *fakeWorker, turnID string) (*contracts.ChatMessage, ToolContext) {
	t.Helper()
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "isolated authorized work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, turnID)
	return message, waitToolScope(t, engine, turnID)
}

func awaitWorkAction(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("isolated work action did not settle")
		return ErrUnknown
	}
}

func assertWorkerQuiet(t *testing.T, worker *fakeWorker) {
	t.Helper()
	select {
	case request := <-worker.requests:
		t.Fatalf("an unadmitted executor action was emitted: %s", request.method)
	default:
	}
}

func TestExplicitPausePersistsQueueAndUnfinishedWorkButWaitsForTheExactTerminal(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	first, owner := beginBehaviorTurn(t, engine, persistence, worker, "pause-owned-turn")
	queued, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "later authorized work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(context.Background(), queued); err != nil {
		t.Fatal(err)
	}
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "verify remaining result", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "earlier-owned-turn", Source: "chat", Title: "unfinished authorized work", Plan: &plan,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(context.Background(), record.TurnID, store.UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true,
	}); err != nil {
		t.Fatal(err)
	}

	result := make(chan error, 1)
	go func() { result <- engine.Pause(context.Background()) }()
	interrupt := nextRequest(t, worker, "turn/interrupt")
	if eventString(interrupt.params, "turnId") != owner.TurnID || eventString(interrupt.params, "threadId") != owner.ThreadID {
		t.Fatal("pause targeted another execution owner")
	}
	interrupt.result <- fakeResponse{value: contracts.RawObject{}}
	if err := engine.Handle(context.Background(), terminal("unrelated-turn", "interrupted")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-result:
		t.Fatal("an interrupt acknowledgement or unrelated terminal proved execution stopped")
	default:
	}
	if !engine.Snapshot().Executor.Paused || len(engine.Snapshot().Queue) != 0 || engine.Snapshot().Active == nil {
		t.Fatal("pause lost the still-owned execution or retained an automatic queue")
	}

	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "interrupted")); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, result); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first.ID, queued.ID} {
		message, err := persistence.Message(id)
		if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || message.UnknownOutcome {
			t.Fatal("explicit pause failed to retain known unfinished work", err)
		}
		if id == queued.ID && message.PauseReason.Value != "user-paused" {
			t.Fatal("queued work lost its explicit human pause reason")
		}
	}
	state := persistence.Snapshot()
	work, err := store.FindWork(&state, record.ID)
	if err != nil || work.Status != contracts.WorkStatusPaused || work.Continuation != nil && work.Continuation.NextAt.Present && !work.Continuation.NextAt.Null {
		t.Fatal("explicit pause left a due automatic continuation", err)
	}
	engine.Wake()
	assertWorkerQuiet(t, worker)
}

func TestUnknownInterruptCannotBeResumedOrMistakenForAConfirmedStop(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "uncertain-interrupt-turn")
	result := make(chan error, 1)
	go func() { result <- engine.Pause(context.Background()) }()
	interrupt := nextRequest(t, worker, "turn/interrupt")
	interrupt.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	if err := awaitWorkAction(t, result); !errors.Is(err, ErrUnknown) {
		t.Fatal("an unconfirmed interrupt became a known safe stop", err)
	}
	if state := engine.Snapshot(); state.Active == nil || state.Active.TurnID.Value != owner.TurnID || !state.Executor.Paused {
		t.Fatal("unconfirmed interruption retired the active execution identity")
	}
	if _, err := engine.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{ConfirmUnknown: true}); !errors.Is(err, ErrBusy) {
		t.Fatal("a still-owned unknown execution was replayed", err)
	}
	if _, valid := engine.ToolScope(); valid {
		t.Fatal("an uncertain stopped owner retained tool permission")
	}
	engine.Wake()
	assertWorkerQuiet(t, worker)

	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "interrupted")); err != nil {
		t.Fatal(err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
		t.Fatal("later terminal erased the original unconfirmed action outcome", err)
	}
}

func TestProgressCancellationChecksCapturedIdentityAndPreservesPauseVersusCancel(t *testing.T) {
	for _, pauseOnly := range []bool{false, true} {
		name := "cancel"
		if pauseOnly {
			name = "pause"
		}
		t.Run(name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, owner := beginBehaviorTurn(t, engine, persistence, worker, "progress-owned-turn")
			target := ProgressTarget{ID: message.ID, Kind: "task", TurnID: contracts.Some(owner.TurnID), CallID: contracts.Null[string](), ConversationID: owner.ConversationID}
			for _, stale := range []ProgressTarget{
				{ID: target.ID, Kind: target.Kind},
				{ID: target.ID, Kind: target.Kind, TurnID: contracts.Some("wrong-turn")},
				{ID: target.ID, Kind: target.Kind, TurnID: target.TurnID, CallID: contracts.Some("wrong-call")},
				{ID: target.ID, Kind: target.Kind, TurnID: target.TurnID, ConversationID: "wrong-conversation"},
				{ID: target.ID, Kind: "unexpected", TurnID: target.TurnID},
			} {
				if _, err := engine.CancelProgress(context.Background(), stale, pauseOnly); err == nil {
					t.Fatal("a stale or incomplete progress identity reached execution")
				}
			}
			assertWorkerQuiet(t, worker)

			result := make(chan error, 1)
			var receipt json.RawMessage
			go func() {
				var err error
				receipt, err = engine.CancelProgress(context.Background(), target, pauseOnly)
				result <- err
			}()
			interrupt := nextRequest(t, worker, "turn/interrupt")
			interrupt.result <- fakeResponse{value: contracts.RawObject{}}
			if err := engine.Handle(context.Background(), terminal(owner.TurnID, "interrupted")); err != nil {
				t.Fatal(err)
			}
			if err := awaitWorkAction(t, result); err != nil {
				t.Fatal(err)
			}
			var response struct{ OK, Cancelled, Paused bool }
			if json.Unmarshal(receipt, &response) != nil || !response.OK || response.Cancelled == pauseOnly || response.Paused != pauseOnly {
				t.Fatal("the cancellation receipt confused pause with cancellation")
			}
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.UnknownOutcome || engine.Snapshot().Active != nil {
				t.Fatal("the exact terminal did not settle the owned message", err)
			}
			if pauseOnly {
				if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.CancelledAt.Present {
					t.Fatal("pause was persisted as cancellation")
				}
			} else if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusCancelled) || !stored.CancelledAt.Present || stored.PauseReason.Value != "" {
				t.Fatal("explicit cancellation did not persist its own terminal state")
			}
		})
	}
}

func TestDetachedProgressCancellationIsDurableAndRejectsUnknownWork(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		name := "confirmed"
		if unknown {
			name = "unknown"
		}
		t.Run(name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "retained work", TurnID: contracts.Some("detached-turn"),
				Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusConfirmed),
			})
			if err != nil {
				t.Fatal(err)
			}
			plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "unfinished isolated step", Status: contracts.PlanStepStatusPending}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			record, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
				TurnID: message.TurnID.Value, MessageID: message.ID, Source: "chat", Title: "retained work", Plan: &plan,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
				current, err := store.FindMessage(state, message.ID)
				if err != nil {
					return err
				}
				current.WorkID = record.ID
				if unknown {
					current.UnknownOutcome = true
					current.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			target := ProgressTarget{ID: record.ID, Kind: "work", TurnID: message.TurnID, ConversationID: persistence.ConversationID()}
			_, err = engine.CancelProgress(context.Background(), target, false)
			if unknown {
				if !errors.Is(err, ErrUnknown) {
					t.Fatal("unknown durable work was treated as a safely cancelled action", err)
				}
				state := persistence.Snapshot()
				if state.WorkTasks[0].Status == contracts.WorkStatusCancelled {
					t.Fatal("rejected cancellation partially committed a work change")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertWorkerQuiet(t, worker)
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			directory := persistence.Directory()
			persistence.Close()
			reopened, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			state := reopened.Snapshot()
			if state.WorkTasks[0].Status != contracts.WorkStatusCancelled || !state.WorkTasks[0].ExecutionEndedAt.Present || !state.WorkTasks[0].CancelledAt.Present {
				t.Fatal("cancelled work lost its durable execution boundary after reopening")
			}
			stored, err := reopened.Message(message.ID)
			if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusCancelled) || !stored.CancelledAt.Present {
				t.Fatal("cancelled message was reopened as runnable work", err)
			}
		})
	}
}

func TestComputerAcquisitionPausesWorkAndReleaseNeverAutomaticallyResumesIt(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := engine.BeginComputerAcquire(); err != nil {
		t.Fatal(err)
	}
	if !engine.Snapshot().Acquiring || engine.Snapshot().Takeover {
		t.Fatal("computer reservation was not visible during its handshake")
	}
	if err := engine.BeginComputerAcquire(); !errors.Is(err, ErrBusy) {
		t.Fatal("a second computer acquisition overlapped its owner", err)
	}
	engine.AbortComputerAcquire()
	engine.AbortComputerAcquire()
	if engine.Snapshot().Acquiring {
		t.Fatal("aborted computer handshake retained its reservation")
	}
	if err := engine.BeginComputerAcquire(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := engine.Snapshot(); !state.Takeover || state.Acquiring || !state.Executor.Paused {
		t.Fatal("computer ownership did not retain the user's paused execution state")
	}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "work entered during human control"})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal("human-control input could not be safely retained", err)
	}
	if err := engine.Release(); err != nil {
		t.Fatal(err)
	}
	if state := engine.Snapshot(); state.Takeover || state.Acquiring || !state.Executor.Paused {
		t.Fatal("releasing the computer silently resumed paused work")
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
		t.Fatal("human-control input escaped its paused durable state", err)
	}
	assertWorkerQuiet(t, worker)
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(engine.Release(), ErrClosed) || !errors.Is(engine.Acquire(context.Background()), ErrBusy) || !errors.Is(engine.Pause(context.Background()), ErrClosed) {
		t.Fatal("closed lifecycle accepted a fresh computer or execution action")
	}
}
