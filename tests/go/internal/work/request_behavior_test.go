package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type recordedWorkReply struct {
	id     runtime.RPCID
	result json.RawMessage
}

type requestBehaviorWorker struct {
	*fakeWorker
	recorded chan recordedWorkReply
	replyErr error
}

func (worker *requestBehaviorWorker) Reply(ctx context.Context, id runtime.RPCID, result json.RawMessage) error {
	select {
	case worker.recorded <- recordedWorkReply{id: id, result: append(json.RawMessage(nil), result...)}:
		return worker.replyErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (worker *requestBehaviorWorker) ReplyError(ctx context.Context, id runtime.RPCID, code int, message string) error {
	return worker.Reply(ctx, id, raw(contracts.RawObject{"code": raw(code), "message": raw(message)}))
}

type workToolRouterFunc func(context.Context, string, contracts.RawObject, ToolContext) (json.RawMessage, error)

func (router workToolRouterFunc) Execute(ctx context.Context, name string, args contracts.RawObject, owner ToolContext) (json.RawMessage, error) {
	return router(ctx, name, args, owner)
}

func requestBehaviorFixture(t *testing.T, options Options) (*Engine, *store.Store, *requestBehaviorWorker) {
	t.Helper()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	worker := &requestBehaviorWorker{
		fakeWorker: &fakeWorker{
			requests: make(chan fakeRequest, 16),
			events:   make(chan runtime.Event, 16),
			root:     t.TempDir(),
			replies:  make(chan json.RawMessage, 16),
		},
		recorded: make(chan recordedWorkReply, 32),
	}
	engine, err := New(context.Background(), persistence, worker, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = engine.Close()
		persistence.Close()
	})
	return engine, persistence, worker
}

func workRequest(t *testing.T, owner ToolContext, method string, id json.RawMessage, params contracts.RawObject) runtime.Event {
	t.Helper()
	identity, err := runtime.ParseRPCID(id)
	if err != nil {
		t.Fatal(err)
	}
	if params == nil {
		params = contracts.RawObject{}
	}
	params["threadId"] = raw(owner.ThreadID)
	params["turnId"] = raw(owner.TurnID)
	return runtime.Event{Method: method, ID: contracts.Some(identity), Params: params}
}

func nextWorkReply(t *testing.T, worker *requestBehaviorWorker) recordedWorkReply {
	t.Helper()
	select {
	case reply := <-worker.recorded:
		return reply
	case <-time.After(10 * time.Second):
		t.Fatal("provider request did not receive its bounded reply")
		return recordedWorkReply{}
	}
}

func TestInteractiveInputRepliesPreserveProviderIdentityAndIndependentBlockers(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	message, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "interactive-input-turn")
	signals, unsubscribe, err := engine.SubscribeSignals()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

	first := workRequest(t, owner, "item/tool/requestUserInput", raw("1"), nil)
	second := workRequest(t, owner, "item/tool/requestUserInput", raw(1), nil)
	for _, event := range []runtime.Event{first, first, second} {
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		select {
		case signal := <-signals:
			if signal.Type != "user-input" {
				t.Fatal("input request lost its browser form signal")
			}
		default:
			t.Fatal("distinct string and numeric provider identities were collapsed")
		}
	}
	select {
	case <-signals:
		t.Fatal("repeated provider request emitted a duplicate form")
	default:
	}
	if state := engine.Snapshot(); state.Active == nil || state.Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("pending forms did not block execution progress")
	}
	finishCredential, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	for index, event := range []runtime.Event{second, first} {
		answer := raw(contracts.RawObject{"answers": raw([]string{fmt.Sprintf("answer-%d", index)})})
		if err := engine.RespondToUser(context.Background(), event.ID.Value, answer); err != nil {
			t.Fatal(err)
		}
		reply := nextWorkReply(t, worker)
		if reply.id.Key() != event.ID.Value.Key() || string(reply.result) != string(answer) {
			t.Fatal("an answer was redirected to another provider request")
		}
		if err := engine.RespondToUser(context.Background(), event.ID.Value, answer); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("a settled provider request was answered again", err)
		}
	}
	if engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("answering forms cleared a separate credential blocker")
	}
	finishCredential()
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) || engine.Snapshot().Active.Status != contracts.TaskStatusRunning {
		t.Fatal("settling the final independent blocker did not restore the exact active task", err)
	}
	select {
	case <-worker.recorded:
		t.Fatal("duplicate answer caused an external reply")
	default:
	}
}

func TestUnconfirmedInputReplyIsNotReplayedAndRetiredRequestsCannotBeAnswered(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "unconfirmed-input-turn")
	request := workRequest(t, owner, "item/tool/requestUserInput", raw("unknown-input"), nil)
	if err := engine.Handle(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	worker.replyErr = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
	if err := engine.RespondToUser(context.Background(), request.ID.Value, raw("answer")); !operationUnknown(err) {
		t.Fatal("unknown provider answer was treated as safe to repeat", err)
	}
	_ = nextWorkReply(t, worker)
	if err := engine.RespondToUser(context.Background(), request.ID.Value, raw("answer")); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("unknown reply was automatically made answerable again", err)
	}
	if engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("unknown answer falsely removed the input blocker")
	}
	worker.replyErr = nil
	second := workRequest(t, owner, "item/tool/requestUserInput", raw("retired-input"), nil)
	if err := engine.Handle(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := engine.RespondToUser(context.Background(), second.ID.Value, raw("late")); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("late form answer retained authority after its turn ended", err)
	}
	select {
	case <-worker.recorded:
		t.Fatal("an unknown or retired answer was replayed")
	default:
	}
}

func TestToolRequestsUseValidatedArgumentsCapturedMediaAndFixedFailureReplies(t *testing.T) {
	var calls []ToolContext
	var arguments []contracts.RawObject
	router := workToolRouterFunc(func(_ context.Context, name string, args contracts.RawObject, owner ToolContext) (json.RawMessage, error) {
		if !owner.IsCurrent() {
			t.Fatal("tool router received an unacknowledged execution owner")
		}
		calls = append(calls, owner)
		arguments = append(arguments, args)
		if name == "fixture_failure" {
			return nil, errors.New("fixture-private-tool-error")
		}
		return raw(contracts.RawObject{"accepted": raw(true)}), nil
	})
	media := &admissionCalls{call: contracts.Call{ID: "replacement-media"}}
	engine, persistence, worker := requestBehaviorFixture(t, Options{ToolRouter: router, Calls: media})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "tool-request-turn")

	for index, captured := range []contracts.Optional[string]{contracts.Some("original-media"), contracts.Null[string](), {}} {
		request := workRequest(t, owner, "item/tool/call", raw(fmt.Sprintf("tool-%d", index)), contracts.RawObject{
			"tool": raw("end_call"), "arguments": raw(`{"reason":"fixture"}`),
		})
		request.MediaCallID = captured
		if err := engine.Handle(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		reply := nextWorkReply(t, worker)
		var response struct{ Success bool }
		if reply.id.Key() != request.ID.Value.Key() || json.Unmarshal(reply.result, &response) != nil || !response.Success || eventString(arguments[index], "reason") != "fixture" {
			t.Fatal("tool request changed its identity, encoded arguments or public result")
		}
	}
	if calls[0].CallID != "original-media" || calls[1].CallID != "" || calls[2].CallID != "replacement-media" {
		t.Fatal("captured absent or prior media identity was redirected to the current call")
	}
	failed := workRequest(t, owner, "item/tool/call", raw("failed-tool"), contracts.RawObject{"tool": raw("fixture_failure"), "arguments": raw(contracts.RawObject{})})
	if err := engine.Handle(context.Background(), failed); err != nil {
		t.Fatal(err)
	}
	reply := nextWorkReply(t, worker)
	if strings.Contains(string(reply.result), "fixture-private") || !strings.Contains(string(reply.result), `"success":false`) || !strings.Contains(string(reply.result), "could not be confirmed") {
		t.Fatal("tool failure leaked a raw error or claimed a confirmed result")
	}
	for _, method := range []string{"item/tool/call", "item/unsupported"} {
		request := workRequest(t, owner, method, raw(method), contracts.RawObject{"tool": raw("end_call"), "arguments": raw([]string{"invalid-object"})})
		if err := engine.Handle(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		var rejection struct{ Code int }
		if json.Unmarshal(nextWorkReply(t, worker).result, &rejection) != nil || rejection.Code != -32601 {
			t.Fatal("unsupported provider input was accepted as a tool request")
		}
	}
	if len(calls) != 4 {
		t.Fatal("invalid provider arguments reached the external tool router")
	}
}

func TestProviderInputCapacityRejectsAdditionalRequestsWithoutDiscardingExistingForms(t *testing.T) {
	engine, persistence, worker := requestBehaviorFixture(t, Options{})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "input-capacity-turn")
	for index := range maxPendingUserRequests {
		request := workRequest(t, owner, "item/tool/requestUserInput", raw(fmt.Sprintf("form-%d", index)), nil)
		if err := engine.Handle(context.Background(), request); err != nil {
			t.Fatal(err)
		}
	}
	excess := workRequest(t, owner, "item/tool/requestUserInput", raw("excess-form"), nil)
	if err := engine.Handle(context.Background(), excess); err != nil {
		t.Fatal(err)
	}
	rejection := nextWorkReply(t, worker)
	if rejection.id.Key() != excess.ID.Value.Key() || !strings.Contains(string(rejection.result), "input request limit") {
		t.Fatal("request capacity was neither bounded nor explicitly rejected")
	}
	first := workRequest(t, owner, "item/tool/requestUserInput", raw("form-0"), nil)
	if err := engine.RespondToUser(context.Background(), first.ID.Value, raw("retained-answer")); err != nil {
		t.Fatal("backpressure discarded a previously admitted form", err)
	}
	if nextWorkReply(t, worker).id.Key() != first.ID.Value.Key() || engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("one answered form cleared the other admitted blockers")
	}
}
