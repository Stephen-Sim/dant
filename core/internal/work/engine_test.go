package work

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"sync"
	"testing"
	"time"
)

type fakeRequest struct {
	method string
	params contracts.RawObject
	result chan fakeResponse
	ctx    context.Context
}
type fakeResponse struct {
	value contracts.RawObject
	err   error
}
type fakeWorker struct {
	mu       sync.Mutex
	requests chan fakeRequest
	events   chan runtime.Event
	root     string
	replies  chan json.RawMessage
}

func (f *fakeWorker) RuntimeID() string {
	return "vm:fixture"
}

func (f *fakeWorker) WorkspaceRoot() string {
	return f.root
}

func (f *fakeWorker) Snapshot() contracts.WorkerState {
	return contracts.WorkerState{Status: contracts.ConnectionStatusOnline}
}

func (f *fakeWorker) Connect(context.Context) (contracts.RawObject, error) {
	return contracts.RawObject{}, nil
}

func (f *fakeWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	request := fakeRequest{method: method, params: params, result: make(chan fakeResponse, 1), ctx: ctx}
	select {
	case f.requests <- request:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case result := <-request.result:
		return result.value, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (f *fakeWorker) Reply(ctx context.Context, id runtime.RPCID, result json.RawMessage) error {
	select {
	case f.replies <- result:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *fakeWorker) ReplyError(ctx context.Context, id runtime.RPCID, code int, message string) error {
	return f.Reply(ctx, id, raw(contracts.RawObject{"code": raw(code), "message": raw(message)}))
}

func (f *fakeWorker) SubscribeEvents() (
	<-chan runtime.Event,
	func(),
	error) {
	return f.events, func() {}, nil
}

func (f *fakeWorker) TerminateConfirmed(context.Context) (bool, error) {
	return true, nil
}

func engineFixture(t *testing.T) (*Engine, *store.Store, *fakeWorker) {
	t.Helper()
	return engineFixtureWithStoreOptions(t, store.Options{})
}

func engineFixtureWithStoreOptions(t *testing.T, options store.Options) (*Engine, *store.Store, *fakeWorker) {
	t.Helper()
	persistence, err := store.Open(t.TempDir(), options)
	if err != nil {
		t.Fatal(err)
	}
	worker := &fakeWorker{requests: make(chan fakeRequest, 16), events: make(chan runtime.Event, 16), root: t.TempDir(), replies: make(chan json.RawMessage, 16)}
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

func nextRequest(t *testing.T, worker *fakeWorker, method string) fakeRequest {
	t.Helper()
	select {
	case request := <-worker.requests:
		if request.method != method {
			t.Fatalf("expected %s, got %s", method, request.method)
		}
		return request
	case <-time.After(10 * time.Second):
		t.Fatal("fixture request not produced")
		return fakeRequest{}
	}
}

func acceptThreadAndTurn(t *testing.T, worker *fakeWorker, turnID string) {
	t.Helper()
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture"}`)}}
	turn := nextRequest(t, worker, "turn/start")
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(turnID)})}}
}

func waitSnapshot(
	t *testing.T,
	engine *Engine,
	predicate func(Snapshot) bool) {
	t.Helper()
	changes, cancel := engine.Subscribe()
	defer cancel()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		if predicate(engine.Snapshot()) {
			return
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("expected engine state not reached")
			return
		}
	}
}

func waitToolScope(t *testing.T, engine *Engine, turnID string) ToolContext {
	t.Helper()
	var owner ToolContext
	waitSnapshot(t, engine, func(Snapshot) bool {
		current, ok := engine.ToolScope()
		if !ok || current.TurnID != turnID {
			return false
		}
		owner = current
		return true
	})
	return owner
}

func terminal(turnID, status string) runtime.Event {
	return runtime.Event{Method: "turn/completed", Params: contracts.RawObject{"threadId": raw("thread-fixture"), "turn": raw(contracts.RawObject{"id": raw(turnID), "status": raw(status)})}}
}

func TestAcceptedTaskOutlivesHTTPAbortAndOneTurnOwnsAllExecution(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	requestContext, cancelRequest := context.WithCancel(context.Background())
	first, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if err = engine.Enqueue(requestContext, first); err != nil {
		t.Fatal(err)
	}
	cancelRequest()
	acceptThreadAndTurn(t, worker, "turn-first")
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return state.Active != nil && state.Active.TurnID.Value == "turn-first"
	})
	second, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "second"})
	if err = engine.Enqueue(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-worker.requests:
		t.Fatalf("second task bypassed active ownership: %s", request.method)
	default:
	}
	if err = engine.Handle(context.Background(), terminal("unrelated", "completed")); err != nil {
		t.Fatal(err)
	}
	if engine.Snapshot().Active.TurnID.Value != "turn-first" {
		t.Fatal("unrelated terminal ended current task")
	}
	if err = engine.Handle(context.Background(), terminal("turn-first", "completed")); err != nil {
		t.Fatal(err)
	}
	turn := nextRequest(t, worker, "turn/start")
	if eventString(turn.params, "threadId") != "thread-fixture" {
		t.Fatal("conversation thread changed")
	}
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": json.RawMessage(`{"id":"turn-second"}`)}}
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return state.Active != nil && state.Active.TurnID.Value == "turn-second"
	})
	stored, _ := persistence.Message(first.ID)
	if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) {
		t.Fatal("an ended response marked entrusted work completed")
	}
}

func TestUnconfirmedStartPausesQueueAndCannotAutomaticallyReplay(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	first, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "side effect"})
	second, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "later"})
	_ = engine.Enqueue(context.Background(), first)
	_ = engine.Enqueue(context.Background(), second)
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture"}`)}}
	turn := nextRequest(t, worker, "turn/start")
	turn.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return state.Active == nil && state.Executor.Paused
	})
	stored, _ := persistence.Message(first.ID)
	if !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown {
		t.Fatal("unknown submission became known failure")
	}
	if _, err := engine.ResumePaused(context.Background(), []string{first.ID}, ResumeOptions{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("unknown task resumed without explicit reconciliation")
	}
	engine.Wake()
	select {
	case request := <-worker.requests:
		t.Fatalf("unknown start was replayed: %s", request.method)
	default:
	}
}

func TestTurnNotificationsCannotBindBeforeStartAcknowledgement(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "work"})
	_ = engine.Enqueue(context.Background(), message)
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture"}`)}}
	turn := nextRequest(t, worker, "turn/start")
	if err := engine.Handle(context.Background(), terminal("wrong-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	if engine.Snapshot().Active.TurnID.Value != "" {
		t.Fatal("notification invented accepted turn")
	}
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": json.RawMessage(`{"id":"real-turn"}`)}}
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return state.Active != nil && state.Active.TurnID.Value == "real-turn"
	})
	if engine.Snapshot().Active == nil {
		t.Fatal("early unrelated terminal completed acknowledged task")
	}
}
