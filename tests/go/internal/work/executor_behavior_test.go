package work

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type observedEventWorker struct {
	*fakeWorker
	once    sync.Once
	retired chan struct{}
}

func (worker *observedEventWorker) SubscribeEvents() (<-chan runtime.Event, func(), error) {
	return worker.events, func() { worker.once.Do(func() { close(worker.retired) }) }, nil
}

func observedEventFixture(t *testing.T) (*Engine, *store.Store, *observedEventWorker) {
	t.Helper()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	worker := &observedEventWorker{
		fakeWorker: &fakeWorker{
			requests: make(chan fakeRequest, 16), events: make(chan runtime.Event, 16),
			root: t.TempDir(), replies: make(chan json.RawMessage, 16),
		},
		retired: make(chan struct{}),
	}
	engine, err := New(context.Background(), persistence, worker, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = engine.Close()
		persistence.Close()
	})
	return engine, persistence, worker
}

func waitEventRetirement(t *testing.T, worker *observedEventWorker) {
	t.Helper()
	select {
	case <-worker.retired:
	case <-time.After(10 * time.Second):
		t.Fatal("closed executor event stream was not retired")
	}
}

func TestIdleExecutorDisconnectionPreservesTheUsersExplicitPause(t *testing.T) {
	engine, persistence, worker := observedEventFixture(t)
	if err := engine.Pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	openNativeBehaviorThread(t, engine, worker.fakeWorker)
	close(worker.events)
	waitEventRetirement(t, worker)
	if !engine.Snapshot().Executor.Paused {
		t.Fatal("idle executor disconnection silently cleared the user's explicit pause")
	}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "retained after transport loss"})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal("new input could not remain durably paused", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("transport loss admitted work that the human explicitly paused", err)
	}
	assertWorkerQuiet(t, worker.fakeWorker)
}

func TestExecutorDisconnectionRetainsUnknownOwnershipAndDoesNotReplayItsQueue(t *testing.T) {
	engine, persistence, worker := observedEventFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "lost-executor-turn")
	queued, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "retained later work"})
	if err != nil || engine.Enqueue(context.Background(), queued) != nil {
		t.Fatal(err)
	}
	close(worker.events)
	waitEventRetirement(t, worker)
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && snapshot.Executor.Paused })
	stored, err := persistence.Message(message.ID)
	if err != nil || !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || stored.PauseReason.Value != "executor-disconnected" || stored.TurnID.Value != owner.TurnID {
		t.Fatal("lost transport changed an unconfirmed executor outcome into a known failure", err)
	}
	if len(engine.Snapshot().Queue) != 1 || engine.Snapshot().Queue[0] != queued.ID {
		t.Fatal("disconnection lost the unrelated durable queue")
	}
	if _, err := engine.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("transport loss authorized an automatic retry", err)
	}
	if owner.IsCurrent() {
		t.Fatal("retired executor retained permission to publish or use tools")
	}
	engine.Wake()
	assertWorkerQuiet(t, worker.fakeWorker)
}

func TestAProviderRejectedStartRemainsKnownUnsubmittedInsteadOfBecomingUnknown(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "known rejected isolated action"})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal(err)
	}
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	request := nextRequest(t, worker, "turn/start")
	request.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrRequestFailed, UnknownOutcome: false}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.UnknownOutcome || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted {
		t.Fatal("a confirmed rejection retained a submitting/unknown fence that falsely requires uncertain-action confirmation", err)
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
	stored, err = reopened.Message(message.ID)
	if err != nil || stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) {
		t.Fatal("reopening upgraded a known rejection into an uncertain action", err)
	}
	restarted, err := New(context.Background(), reopened, worker, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	reservation, err := restarted.ReserveCallStart(context.Background(), "known-rejection-retry-call", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := restarted.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{})
	if err != nil || len(selected) != 1 || selected[0] != message.ID || !restarted.CallStartCurrent(reservation) {
		t.Fatal("a known rejection incorrectly required unknown-action confirmation", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestConfirmedProcessStopDoesNotProveAnUnacknowledgedActionWasNeverAccepted(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "pending isolated action"})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal(err)
	}
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	request := nextRequest(t, worker, "turn/start")
	if err := engine.ConfirmStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	request.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Submission.Value == contracts.SubmissionStatusNotSubmitted || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
		t.Fatal("process-stop proof erased the uncertainty of an earlier unacknowledged request", err)
	}
	assertWorkerQuiet(t, worker)
}
