package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type nativeFixtureWorker struct {
	mu          sync.Mutex
	voice       *Native
	requests    []string
	turns       []contracts.RawObject
	readStatus  string
	appendError error
	startError  error
	appendCalls atomic.Int32
	appended    []string
}

func (worker *nativeFixtureWorker) RuntimeID() string     { return "fixture-runtime" }
func (worker *nativeFixtureWorker) WorkspaceRoot() string { return "/fixture-workspace" }
func (worker *nativeFixtureWorker) Snapshot() contracts.WorkerState {
	return contracts.WorkerState{Status: contracts.ConnectionStatusOnline}
}

func (worker *nativeFixtureWorker) Connect(context.Context) (contracts.RawObject, error) {
	return contracts.RawObject{}, nil
}

func (worker *nativeFixtureWorker) Reply(context.Context, runtime.RPCID, json.RawMessage) error {
	return nil
}

func (worker *nativeFixtureWorker) SubscribeEvents() (<-chan runtime.Event, func(), error) {
	return nil, func() {}, nil
}

func (worker *nativeFixtureWorker) TerminateConfirmed(context.Context) (bool, error) {
	return false, errors.New("must not terminate fixture executor")
}

func (worker *nativeFixtureWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	worker.mu.Lock()
	worker.requests = append(worker.requests, method)
	voice := worker.voice
	turns := worker.turns
	status := worker.readStatus
	appendError := worker.appendError
	startError := worker.startError
	worker.mu.Unlock()
	event := func(method string, p map[string]any) {
		p["threadId"] = "shared-thread"
		if err := voice.HandleEvent(ctx, runtime.Event{Method: method, Params: object(p)}); err != nil {
			return
		}
	}
	switch method {
	case "thread/realtime/start":
		if startError != nil {
			return nil, startError
		}
		event("thread/realtime/started", map[string]any{"version": "v3", "realtimeSessionId": "media-" + textField(params, "voiceSessionId")})
		event("thread/realtime/sdp", map[string]any{"sdp": fixtureSDP})
	case "thread/realtime/stop":
		event("thread/realtime/closed", map[string]any{})
	case "thread/realtime/appendText":
		worker.appendCalls.Add(1)
		worker.mu.Lock()
		worker.appended = append(worker.appended, textField(params, "text"))
		worker.mu.Unlock()
		return contracts.RawObject{}, appendError
	case "thread/read":
		if turns == nil {
			turns = []contracts.RawObject{}
		}
		if status == "" {
			status = "idle"
		}
		return object(map[string]any{"thread": map[string]any{"id": "shared-thread", "status": map[string]any{"type": status}, "turns": turns}}), nil
	case "thread/realtime/listVoices":
		return object(map[string]any{"voices": map[string]any{"v3": []string{"ember", "juniper"}}}), nil
	}
	return contracts.RawObject{}, nil
}

type nativeFixtureEngine struct {
	mu                sync.Mutex
	state             *store.Store
	reservation       work.CallStartReservation
	active            *contracts.ActiveExecution
	adopted           []work.NativeTurnInput
	events            []runtime.Event
	continued, paused atomic.Int32
}

func (engine *nativeFixtureEngine) Thread(context.Context) (string, error) {
	return "shared-thread", nil
}

func (engine *nativeFixtureEngine) Snapshot() work.Snapshot {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return work.Snapshot{Active: engine.active}
}

func (engine *nativeFixtureEngine) ReserveCallStart(ctx context.Context, id, provider string) (work.CallStartReservation, error) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.reservation = work.CallStartReservation{CallID: id, Provider: provider, ConversationID: engine.state.Snapshot().ConversationID, Token: "reservation"}
	return engine.reservation, nil
}

func (engine *nativeFixtureEngine) CallStartCurrent(value work.CallStartReservation) bool {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return engine.reservation == value
}

func (engine *nativeFixtureEngine) ReleaseCallStart(value work.CallStartReservation) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.reservation == value {
		engine.reservation = work.CallStartReservation{}
	}
}

func (engine *nativeFixtureEngine) AdoptNativeTurn(ctx context.Context, input work.NativeTurnInput) (work.ToolContext, error) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.adopted = append(engine.adopted, input)
	engine.active = &contracts.ActiveExecution{TurnID: contracts.Some(input.TurnID), ThreadID: contracts.Some(input.ThreadID), WorkID: "accepted-work", Status: contracts.TaskStatusRunning}
	return work.ToolContext{ConversationID: input.ConversationID, ThreadID: input.ThreadID, TurnID: input.TurnID, CallID: input.CallID, WorkID: "accepted-work"}, nil
}

func (engine *nativeFixtureEngine) HandleNativeEvent(ctx context.Context, owner work.ToolContext, event runtime.Event) error {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if turnID(event) != owner.TurnID {
		return work.ErrStaleOwner
	}
	engine.events = append(engine.events, event)
	if event.Method == "turn/completed" {
		engine.active = nil
	}
	return nil
}

func (engine *nativeFixtureEngine) NativeTaskSnapshot(owner work.ToolContext) *contracts.ActiveExecution {
	return engine.Snapshot().Active
}

func (engine *nativeFixtureEngine) ContinueNativeWork(work.ToolContext) error {
	engine.continued.Add(1)
	return nil
}

func (engine *nativeFixtureEngine) PauseNativeWork(context.Context, work.ToolContext) error {
	engine.paused.Add(1)
	return nil
}

func nativeFixture(t *testing.T) (*Native, *nativeFixtureWorker, *nativeFixtureEngine, *store.Store) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = persistence.Mutate(ctx, func(state *contracts.State) error { state.ThreadID = contracts.Some("shared-thread"); return nil }); err != nil {
		t.Fatal(err)
	}
	worker := &nativeFixtureWorker{}
	engine := &nativeFixtureEngine{state: persistence}
	voice, err := NewNative(ctx, NativeOptions{Worker: worker, Engine: engine, Store: persistence, RememberCallInput: func(context.Context, *contracts.ChatMessage, string) error { return nil }, ConnectTimeout: time.Second, StopTimeout: time.Second, ContextTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	worker.voice = voice
	t.Cleanup(func() { cancel(); persistence.Close() })
	return voice, worker, engine, persistence
}

func startNativeFixture(t *testing.T, voice *Native) {
	t.Helper()
	result, err := voice.Start(context.Background(), NativeStart{SDP: fixtureSDP, CallID: "call-one", Voice: "ember"})
	if err != nil || result.SDP != fixtureSDP || voice.Call().Status != "negotiating" {
		t.Fatal("native handshake failed", err)
	}
	if err = voice.ConfirmConnected("call-one"); err != nil {
		t.Fatal(err)
	}
}

func TestNativeHandshakeRequiresStartedAndSDPAndOldScopeCannotAcknowledge(t *testing.T) {
	voice, _, _, _ := nativeFixture(t)
	startNativeFixture(t, voice)
	if err := voice.ConfirmConnected("other-call"); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("stale client connected another call")
	}
	if err := voice.HandleEvent(context.Background(), runtime.Event{Method: "thread/realtime/closed", Params: object(map[string]any{"threadId": "other-thread", "callId": "call-one"})}); err != nil || voice.Call() == nil {
		t.Fatal("foreign thread closed current call")
	}
	if err := voice.Stop(context.Background(), "call-one"); err != nil || voice.Call() != nil {
		t.Fatal("native idle shutdown failed", err)
	}
}

func TestNativeWorkNeedsHandoffAndTurnAcknowledgementThenSurvivesMediaHangup(t *testing.T) {
	voice, worker, engine, _ := nativeFixture(t)
	startNativeFixture(t, voice)
	started := runtime.Event{Method: "turn/started", Params: object(map[string]any{"threadId": "shared-thread", "turn": map[string]any{"id": "turn-one", "status": "inProgress"}})}
	if err := voice.HandleEvent(context.Background(), started); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	engine.mu.Lock()
	count := len(engine.adopted)
	engine.mu.Unlock()
	if count != 0 {
		t.Fatal("unsolicited turn was admitted")
	}
	handoff := runtime.Event{Method: "thread/realtime/itemAdded", Params: object(map[string]any{"threadId": "shared-thread", "item": map[string]any{"type": "handoff_request", "handoff_id": "handoff-one", "item_id": "item-one", "input_transcript": "Entrusted request", "active_transcript": []contracts.RawObject{}}})}
	if err := voice.HandleEvent(context.Background(), handoff); err != nil {
		t.Fatal(err)
	}
	waitVoice(t, func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return len(engine.adopted) == 1 && len(engine.events) == 1
	})
	worker.mu.Lock()
	worker.turns = []contracts.RawObject{object(map[string]any{"id": "turn-one", "status": "inProgress"})}
	worker.readStatus = "active"
	worker.mu.Unlock()
	if err := voice.Stop(context.Background(), "call-one"); err != nil {
		t.Fatal(err)
	}
	if voice.Call() != nil || !voice.Snapshot().Background || engine.continued.Load() != 1 || engine.paused.Load() != 0 || !voice.PendingWork() {
		t.Fatal("hangup cancelled or lost accepted work")
	}
	if err := voice.HandleEvent(context.Background(), runtime.Event{Method: "turn/completed", Params: object(map[string]any{"threadId": "shared-thread", "turn": map[string]any{"id": "turn-one", "status": "completed"}})}); err != nil {
		t.Fatal(err)
	}
	waitVoice(t, func() bool { return !voice.PendingWork() })
}

func TestNativeTypedInputPersistsConfirmationAndUnknownNeverRetries(t *testing.T) {
	voice, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, voice)
	result, err := voice.Message(context.Background(), NativeMessage{ClientMessageID: "first-input", CallID: "call-one", Text: "Typed request"})
	if err != nil || result.Submission != "confirmed" || result.Message == nil {
		t.Fatal("typed receipt failed", err)
	}
	if duplicate, err := voice.Message(context.Background(), NativeMessage{ClientMessageID: "first-input", CallID: "call-one", Text: "Typed request"}); err != nil || !duplicate.Duplicate || worker.appendCalls.Load() != 1 {
		t.Fatal("typed input replayed")
	}
	worker.mu.Lock()
	worker.appendError = runtime.ErrDisconnected
	worker.mu.Unlock()
	_, err = voice.Message(context.Background(), NativeMessage{ClientMessageID: "second-input", CallID: "call-one", Text: "Another request"})
	var inputErr *VoiceInputError
	if !errors.As(err, &inputErr) || !inputErr.UnknownOutcome {
		t.Fatal("lost RPC was safe-retry", err)
	}
	state := persistence.Snapshot()
	last := state.Messages[len(state.Messages)-1]
	status, _ := last.Status.Get()
	submission, _ := last.Submission.Get()
	if status != contracts.MessageStatus(contracts.TaskStatusPaused) || submission != contracts.SubmissionStatusUnknown {
		t.Fatal("uncertain typed input not durable")
	}
	if _, err = voice.Message(context.Background(), NativeMessage{ClientMessageID: "third-input", CallID: "call-one", Text: "Later request"}); !errors.Is(err, ErrNativeUnknown) || worker.appendCalls.Load() != 2 {
		t.Fatal("unknown handoff did not block more input")
	}
}

func TestNativeConcurrentClientIDIsPersistedAndSubmittedOnce(t *testing.T) {
	voice, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, voice)
	input := NativeMessage{ClientMessageID: "same-input", CallID: "call-one", Text: "one request"}
	var workers sync.WaitGroup
	results := make(chan error, 12)
	for range 12 {
		workers.Add(1)
		go func() { defer workers.Done(); _, err := voice.Message(context.Background(), input); results <- err }()
	}
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if worker.appendCalls.Load() != 1 || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("concurrent client identity created duplicate work")
	}
}

func TestNativeRejectedAndUnknownStartRemainDistinctAndWorkersJoin(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(fmt.Sprint(unknown), func(t *testing.T) {
			voice, worker, _, _ := nativeFixture(t)
			worker.startError = &runtime.OperationError{Cause: errors.New("private provider output"), UnknownOutcome: unknown}
			_, err := voice.Start(context.Background(), NativeStart{SDP: fixtureSDP, CallID: "call-one"})
			if err == nil {
				t.Fatal("failed start became connected")
			}
			state := voice.Snapshot()
			if unknown && (state.Call == nil || !state.Unknown || state.Call.Status != contracts.VoiceCallStatusStopUnconfirmed) || !unknown && state.Call != nil {
				t.Fatal("start certainty was lost")
			}
			if state.Error == nil || *state.Error != ErrVoiceConnection.Error() {
				t.Fatal("unbounded provider error escaped into state")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err = voice.Close(ctx)
			if unknown && !errors.Is(err, ErrNativeStop) || !unknown && err != nil {
				t.Fatal("shutdown certainty changed", err)
			}
			waitVoice(t, func() bool { voice.mu.Lock(); defer voice.mu.Unlock(); return len(voice.sessions) == 0 })
			worker.mu.Lock()
			defer worker.mu.Unlock()
			for _, method := range worker.requests {
				if method == "thread/realtime/stop" {
					t.Fatal("unknown start retried an external media operation")
				}
			}
		})
	}
}
