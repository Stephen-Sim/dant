package voice

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func nativeEventFixture(t *testing.T) (*Native, *nativeSession) {
	t.Helper()
	native, s, _ := continuationFixture(t)
	s.ctx = t.Context()
	s.failure = make(chan error, 1)
	s.ready = make(chan struct{})
	s.closedSignal = make(chan struct{})
	s.handoffs = map[string]*nativeHandoff{}
	s.pendingTurns = map[string][]runtime.Event{}
	s.workEvents = make(chan nativeQueuedEvent, 1)
	s.mediaEvents = make(chan nativeQueuedEvent, 1)
	return native, s
}

func TestNativeEventAdmissionCapturesGenerationAndRefusesQueueOverflow(t *testing.T) {
	native, s := nativeEventFixture(t)
	event := runtime.Event{Method: "thread/realtime/notice", Params: object(map[string]any{"threadId": s.threadID})}
	if !native.OwnsEvent(event) {
		t.Fatal("current realtime event was not owned")
	}
	if err := native.HandleEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	queued := <-s.workEvents
	if queued.generation != s.generation || queued.bytes == 0 || s.queuedEvents != 1 {
		t.Fatal("event admission did not capture bounded generation metadata")
	}
	s.workEvents <- queued
	if err := native.HandleEvent(t.Context(), event); !errors.Is(err, ErrNativeUnknown) || !s.unknown {
		t.Fatal("full event channel was treated as accepted", err)
	}
	s.unknown = false
	s.queuedEvents = nativeEventLimit
	if err := native.HandleEvent(t.Context(), event); !errors.Is(err, ErrNativeUnknown) || !s.unknown {
		t.Fatal("event count budget was ignored", err)
	}
	s.queuedEvents = 0
	s.continuation = &nativeContinuation{}
	event.Method = "thread/realtime/itemAdded"
	event.Params["item"] = rawValue(map[string]any{"type": "handoff_request"})
	_ = native.HandleEvent(t.Context(), event)
	if !s.continuation.conflict {
		t.Fatal("concurrent handoff did not fence pending continuation")
	}
	for _, method := range []string{"other/notification", "turn/started", "item/delta"} {
		candidate := runtime.Event{Method: method, Params: object(map[string]any{"threadId": "foreign", "turnId": "turn"})}
		if native.OwnsEvent(candidate) {
			t.Fatal("foreign thread event became owned")
		}
		candidate.Params["threadId"] = rawValue(s.threadID)
		if native.OwnsEvent(candidate) != (method != "other/notification") {
			t.Fatal("event family boundary changed")
		}
	}
	engine := native.options.Engine.(*nativeFixtureEngine)
	engine.active = &contracts.ActiveExecution{TurnID: contracts.Some("turn")}
	if native.OwnsEvent(runtime.Event{Method: "turn/started", Params: object(map[string]any{"threadId": s.threadID, "turnId": "turn"})}) {
		t.Fatal("ordinary engine turn was adopted by live media")
	}
	s.turns["turn"] = &nativeTurn{}
	if !native.OwnsEvent(runtime.Event{Method: "turn/started", Params: object(map[string]any{"threadId": s.threadID, "turnId": "turn"})}) {
		t.Fatal("already tracked native turn lost ownership")
	}
}

func TestNativeMediaEventsIgnoreRetiredGenerationAndRejectInvalidHandshakes(t *testing.T) {
	for _, test := range []struct {
		method string
		params map[string]any
	}{
		{"thread/realtime/started", map[string]any{"version": "v2"}},
		{"thread/realtime/sdp", map[string]any{"sdp": "invalid"}},
		{"thread/realtime/error", map[string]any{}},
	} {
		t.Run(test.method, func(t *testing.T) {
			native, s := nativeEventFixture(t)
			if err := native.processEvent(s, nativeQueuedEvent{event: runtime.Event{Method: test.method, Params: object(test.params)}, generation: s.generation}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-s.failure:
				if !errors.Is(err, ErrVoiceConnection) {
					t.Fatal("invalid handshake lost its classified failure", err)
				}
			default:
				t.Fatal("invalid provider handshake was not reported")
			}
		})
	}
	native, s := nativeEventFixture(t)
	for _, params := range []map[string]any{{"realtimeSessionId": "retired"}, {"item": map[string]any{"realtime_session_id": "retired"}}, {"item": map[string]any{"realtimeSessionId": "retired"}}, {"callId": "other-call"}} {
		s.retired.add("retired")
		if err := native.processEvent(s, nativeQueuedEvent{event: runtime.Event{Method: "thread/realtime/error", Params: object(params)}, generation: s.generation}); err != nil || s.unknown {
			t.Fatal("retired call changed the current media", err)
		}
	}
	if err := native.processEvent(s, nativeQueuedEvent{event: runtime.Event{Method: "thread/realtime/error"}, generation: s.generation - 1}); err != nil || s.unknown {
		t.Fatal("stale queued generation changed new media", err)
	}
	native.session = nil
	if err := native.processEvent(s, nativeQueuedEvent{event: runtime.Event{Method: "thread/realtime/error"}, generation: s.generation}); err != nil || s.unknown {
		t.Fatal("detached session affected current media", err)
	}
}

func TestNativeHandoffValidationAndTurnBudgetsPreserveUnknownOutcomes(t *testing.T) {
	native, s := nativeEventFixture(t)
	for _, item := range []map[string]any{
		{}, {"handoff_id": "handoff", "item_id": "item", "input_transcript": nil, "active_transcript": []any{}}, {"handoff_id": "handoff", "item_id": "item", "input_transcript": "text", "active_transcript": []any{map[string]any{"role": nil, "text": "text"}}},
	} {
		if err := native.observeHandoff(s, object(item)); !errors.Is(err, ErrNativeUnknown) {
			t.Fatal("malformed handoff was admitted", err)
		}
	}
	valid := func(id, item, text string) contracts.RawObject {
		return object(map[string]any{"handoff_id": id, "item_id": item, "input_transcript": text, "active_transcript": []any{}})
	}
	if err := native.observeHandoff(s, valid("empty", "item", "")); err != nil || len(s.handoffs) != 0 {
		t.Fatal("empty handoff invented a task", err)
	}
	if err := native.observeHandoff(s, valid("handoff", "item", "request")); err != nil || len(s.handoffs) != 1 {
		t.Fatal("valid handoff was not retained", err)
	}
	if err := native.observeHandoff(s, valid("handoff", "item", "request")); err != nil || len(s.handoffs) != 1 {
		t.Fatal("duplicate handoff was not idempotent", err)
	}
	if err := native.observeHandoff(s, valid("handoff", "different-item", "request")); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("duplicate identity changed its owner", err)
	}
	for i := 1; i < nativeTurnLimit; i++ {
		s.handoffs[fmt.Sprintf("retained-%d", i)] = &nativeHandoff{turnID: "accepted"}
	}
	if err := native.observeHandoff(s, valid("overflow", "item", "request")); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("handoff budget was ignored", err)
	}
	s.pendingOrder = []string{"one", "two"}
	if err := native.tryAdopt(s); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("ambiguous pending turns were adopted", err)
	}
	s.pendingOrder = []string{"one"}
	s.pendingTurns["one"] = []runtime.Event{{Method: "item/delta"}}
	if err := native.tryAdopt(s); err != nil || len(s.turns) != 0 {
		t.Fatal("unacknowledged turn was adopted", err)
	}
	s.unknown = true
	if err := native.tryAdopt(s); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("unknown native state was admitted", err)
	}
}
