package voice

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type nativeEventEngineBoundary struct {
	NativeEngine
	adopt  func(context.Context, work.NativeTurnInput) (work.ToolContext, error)
	handle func(context.Context, work.ToolContext, runtime.Event) error
	pause  func(context.Context, work.ToolContext) error
}

func (engine nativeEventEngineBoundary) AdoptNativeTurn(ctx context.Context, input work.NativeTurnInput) (work.ToolContext, error) {
	if engine.adopt != nil {
		return engine.adopt(ctx, input)
	}
	return engine.NativeEngine.AdoptNativeTurn(ctx, input)
}

func (engine nativeEventEngineBoundary) HandleNativeEvent(ctx context.Context, owner work.ToolContext, event runtime.Event) error {
	if engine.handle != nil {
		return engine.handle(ctx, owner, event)
	}
	return engine.NativeEngine.HandleNativeEvent(ctx, owner, event)
}

func (engine nativeEventEngineBoundary) PauseNativeWork(ctx context.Context, owner work.ToolContext) error {
	if engine.pause != nil {
		return engine.pause(ctx, owner)
	}
	return engine.NativeEngine.PauseNativeWork(ctx, owner)
}

func nativeHandoffItem(id string) contracts.RawObject {
	return contracts.RawObject{"handoff_id": rawValue(id), "item_id": rawValue("handoff-item"), "input_transcript": rawValue("Synthetic entrusted request"), "active_transcript": rawValue([]contracts.RawObject{})}
}

func TestNativeHandoffAdoptionPreservesCapturedOwnerAndSettlesBufferedTerminal(t *testing.T) {
	for _, scenario := range []string{"active owner", "buffered terminal", "adoption rejected", "owner changed during adoption", "buffered event rejected", "foreign pending turn"} {
		t.Run(scenario, func(t *testing.T) {
			native, session := nativeEventFixture(t)
			engine := native.options.Engine.(*nativeFixtureEngine)
			failure := errors.New("isolated native ownership rejection")
			boundary := nativeEventEngineBoundary{NativeEngine: engine}
			session.handoffs["handoff"] = &nativeHandoff{itemID: "handoff-item"}
			session.handoffOrder = []string{"handoff"}
			session.pendingOrder = []string{"accepted-turn"}
			session.pendingTurns["accepted-turn"] = []runtime.Event{
				{Method: "turn/started", Params: contracts.RawObject{"turnId": rawValue("accepted-turn")}},
				{Method: "turn/completed", Params: contracts.RawObject{"turnId": rawValue("accepted-turn"), "turn": rawValue(contracts.RawObject{"id": rawValue("accepted-turn"), "status": rawValue("completed")})}},
			}
			switch scenario {
			case "active owner":
				engine.active = &contracts.ActiveExecution{TurnID: contracts.Some("accepted-turn"), ThreadID: contracts.Some(session.threadID), WorkID: "captured-work"}
			case "adoption rejected":
				boundary.adopt = func(context.Context, work.NativeTurnInput) (work.ToolContext, error) {
					return work.ToolContext{}, failure
				}
			case "owner changed during adoption":
				boundary.adopt = func(ctx context.Context, input work.NativeTurnInput) (work.ToolContext, error) {
					owner, err := engine.AdoptNativeTurn(ctx, input)
					native.mu.Lock()
					native.session = nil
					native.mu.Unlock()
					return owner, err
				}
			case "buffered event rejected":
				boundary.handle = func(context.Context, work.ToolContext, runtime.Event) error { return failure }
			case "foreign pending turn":
				engine.active = &contracts.ActiveExecution{TurnID: contracts.Some("foreign-active"), ThreadID: contracts.Some(session.threadID), WorkID: "captured-work"}
			}
			native.options.Engine = boundary
			err := native.tryAdopt(session)
			switch scenario {
			case "adoption rejected", "buffered event rejected":
				if !errors.Is(err, failure) {
					t.Fatal("rejected native event was reported as accepted", err)
				}
			case "owner changed during adoption", "foreign pending turn":
				if !errors.Is(err, ErrNativeUnknown) {
					t.Fatal("changed native owner adopted buffered execution events", err)
				}
			default:
				if err != nil || !session.finished["accepted-turn"] || !session.turns["accepted-turn"].done || len(engine.events) != 2 || len(engine.adopted) != 1 || session.pendingBytes != 0 || len(session.pendingTurns) != 0 {
					t.Fatal("admitted native turn did not settle its exact buffered terminal", err)
				}
				if scenario == "active owner" && (engine.adopted[0].CapturedOwner == nil || engine.adopted[0].CapturedOwner.WorkID != "captured-work") {
					t.Fatal("native adoption discarded the captured work identity")
				}
			}
		})
	}
}

func TestNativeEventLoopPublishesFixedUnknownStateAfterRejectedHandoff(t *testing.T) {
	native, _, _, _ := nativeFixture(t)
	startNativeFixture(t, native)
	event := runtime.Event{Method: "thread/realtime/itemAdded", Params: contracts.RawObject{"threadId": rawValue("shared-thread"), "item": rawValue(contracts.RawObject{"type": rawValue("handoff_request")})}}
	if err := native.HandleEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	waitVoice(t, func() bool { return native.Snapshot().Unknown })
	state := native.Snapshot()
	if state.Error == nil || *state.Error != ErrNativeUnknown.Error() || state.Call == nil {
		t.Fatal("rejected handoff lost its unresolved media owner or fixed diagnostic")
	}
	if err := native.Close(t.Context()); !errors.Is(err, ErrNativeStop) {
		t.Fatal("failed handoff lost uncertainty during shutdown", err)
	}
}

func TestNativeEventProcessingIgnoresSettledTurnsAndBoundsPendingOwnership(t *testing.T) {
	native, session := nativeEventFixture(t)
	for _, id := range []string{"", "finished"} {
		session.finished["finished"] = true
		if err := native.processEvent(session, nativeQueuedEvent{event: runtime.Event{Method: "item/completed", Params: contracts.RawObject{"turnId": rawValue(id)}}}); err != nil || len(session.pendingTurns) != 0 {
			t.Fatal("finished or unidentified turn created pending execution", err)
		}
	}
	session.pendingBytes = nativeEventByteLimit
	if err := native.processEvent(session, nativeQueuedEvent{bytes: 1, event: runtime.Event{Method: "item/completed", Params: contracts.RawObject{"turnId": rawValue("overflow")}}}); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("pending turn exceeded its retained byte allowance", err)
	}
	native.session = nil
	if err := native.observeHandoff(session, nativeHandoffItem("detached")); err != nil || len(session.handoffs) != 0 {
		t.Fatal("detached media handoff reached the current owner", err)
	}
}
