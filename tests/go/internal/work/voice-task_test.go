package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestAPIVoiceTaskRetainsItsExecutionAfterMediaWaiterEnds(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "owned-call", Provider: "api"}}
	media, hangup := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(media, "finish the authorized work", ToolContext{CallID: "owned-call", IsCurrent: func() bool { return true }})
		result <- err
	}()
	acceptThreadAndTurn(t, worker, "voice-owned-turn")
	waitToolScope(t, engine, "voice-owned-turn")
	if err := engine.ContinueVoiceTasks("owned-call"); err != nil {
		t.Fatal(err)
	}
	hangup()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal("ending media did not end only the waiting call request")
	}
	if len(persistence.Snapshot().Messages) != 0 || engine.Snapshot().Active == nil {
		t.Fatal("private call request was copied to chat or accepted work was cancelled")
	}
	if err := engine.Handle(context.Background(), runtime.Event{Method: "item/completed", Params: contracts.RawObject{
		"threadId": raw("thread-fixture"), "turnId": raw("voice-owned-turn"),
		"item": json.RawMessage(`{"id":"answer","type":"agentMessage","text":"The authorized result."}`),
	}}); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal("voice-owned-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Role != contracts.RoleAssistant || state.Messages[0].Text != "The authorized result." {
		t.Fatal("acknowledged work did not report its result in the existing chat")
	}
	if unconfirmedVoiceTasks(state) || engine.Snapshot().Active != nil {
		t.Fatal("confirmed terminal left a stale private execution fence")
	}
}

func TestUnknownPrivateVoiceStartRemainsDurablyFencedAndCannotReplay(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "owned-call", Provider: "api"}}
	result := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(context.Background(), "one external action", ToolContext{CallID: "owned-call", IsCurrent: func() bool { return true }})
		result <- err
	}()
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture"}`)}}
	start := nextRequest(t, worker, "turn/start")
	start.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	if err := <-result; err == nil {
		t.Fatal("unacknowledged task was reported complete")
	}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && snapshot.Executor.Paused })
	if !unconfirmedVoiceTasks(persistence.Snapshot()) || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("unknown private input lost its durable fence or leaked into chat")
	}
	select {
	case <-worker.requests:
		t.Fatal("an unknown voice action was automatically replayed")
	default:
	}
}

func TestSpokenReferenceIsPrivateAndDuplicateUnknownInjectionIsNeverRetried(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "owned-call", Provider: "api"}}
	input := SpeechInput{CallID: "owned-call", ItemID: "spoken-item", Role: contracts.RoleUser, Text: "spoken words"}
	result := make(chan error, 1)
	go func() { result <- engine.RecordSpeech(context.Background(), input) }()
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture"}`)}}
	injection := nextRequest(t, worker, "thread/inject_items")
	injection.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	if err := <-result; !errors.Is(err, ErrSpeechUnconfirmed) {
		t.Fatal("missing speech acknowledgement did not retain uncertainty")
	}
	if err := engine.RecordSpeech(context.Background(), input); !errors.Is(err, ErrSpeechUnconfirmed) {
		t.Fatal("an attempted speech reference was replayable")
	}
	state := persistence.Snapshot()
	var receipt spokenReference
	if len(state.Messages) != 0 || len(state.VoiceHistory) != 1 || json.Unmarshal(state.VoiceHistory[0], &receipt) != nil || receipt.Status != "unknown" {
		t.Fatal("speech did not retain its private durable unknown receipt")
	}
	select {
	case <-worker.requests:
		t.Fatal("a duplicate speech reference reached the executor")
	default:
	}
}
