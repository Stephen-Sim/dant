package voice

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestNativeStopReconcilesObservedTerminalBeforeRetiringItsExactTurn(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		t.Run(map[bool]string{false: "accepted terminal", true: "rejected terminal"}[rejected], func(t *testing.T) {
			native, worker, engine, _ := nativeFixture(t)
			startNativeFixture(t, native)
			native.mu.Lock()
			session := native.session
			session.turns["reconciled-native-turn"] = &nativeTurn{owner: work.ToolContext{TurnID: "reconciled-native-turn", ThreadID: session.threadID}}
			native.mu.Unlock()
			worker.mu.Lock()
			worker.turns = []contracts.RawObject{{"id": rawValue("reconciled-native-turn"), "status": rawValue("completed")}}
			worker.mu.Unlock()
			if rejected {
				native.options.Engine = nativeEventEngineBoundary{NativeEngine: engine, handle: func(context.Context, work.ToolContext, runtime.Event) error { return work.ErrStaleOwner }}
			}
			err := native.Stop(t.Context(), "call-one")
			if rejected {
				if !errors.Is(err, ErrNativeStop) || !native.Snapshot().Unknown || session.turns["reconciled-native-turn"].done {
					t.Fatal("rejected terminal was used as proof that the native owner ended", err)
				}
			} else if err != nil || !session.turns["reconciled-native-turn"].done || !session.finished["reconciled-native-turn"] || len(engine.events) != 1 || native.Call() != nil {
				t.Fatal("readback-proven terminal was not applied to the exact native owner", err)
			}
			_ = native.Close(t.Context())
		})
	}
}

func TestNativePauseFailureRetainsUnknownOwnerAndDoesNotRetry(t *testing.T) {
	native, _, engine, _ := nativeFixture(t)
	startNativeFixture(t, native)
	native.mu.Lock()
	native.session.turns["pause-failed-turn"] = &nativeTurn{owner: work.ToolContext{TurnID: "pause-failed-turn", ThreadID: "shared-thread"}}
	native.mu.Unlock()
	failed := errors.New("isolated pause failure")
	calls := 0
	native.options.Engine = nativeEventEngineBoundary{NativeEngine: engine, pause: func(context.Context, work.ToolContext) error { calls++; return failed }}
	if err := native.PauseWork(t.Context()); !errors.Is(err, failed) || !native.Snapshot().Unknown || calls != 1 {
		t.Fatal("failed pause discarded its unresolved executor identity", err)
	}
	if err := native.Close(t.Context()); !errors.Is(err, ErrNativeStop) || calls != 1 {
		t.Fatal("unknown pause was retried during shutdown", err)
	}
}

func TestNativeStopRequiresTransportAndClosedAcknowledgement(t *testing.T) {
	for _, scenario := range []string{"stop rejected", "closed acknowledgement missing", "tracked turn missing", "changed generation during read"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				native, worker, _, _ := nativeFixture(t)
				startNativeFixture(t, native)
				if scenario == "tracked turn missing" {
					native.mu.Lock()
					native.session.turns["missing-tracked-turn"] = &nativeTurn{done: true}
					native.mu.Unlock()
				}
				native.options.Worker = nativeStartWorkerBoundary{Worker: worker, request: func(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
					if method == "thread/realtime/stop" {
						if scenario == "stop rejected" {
							return nil, errors.New("isolated native stop failure")
						}
						if scenario == "closed acknowledgement missing" {
							return contracts.RawObject{}, nil
						}
					}
					result, err := worker.Request(ctx, method, params)
					if method == "thread/read" && scenario == "changed generation during read" {
						native.mu.Lock()
						native.session.generation++
						native.mu.Unlock()
					}
					return result, err
				}}
				if err := native.Stop(t.Context(), "foreign-call"); !errors.Is(err, ErrVoiceCancelled) {
					t.Fatal("foreign media request stopped the current call", err)
				}
				if err := native.Stop(t.Context(), "call-one"); !errors.Is(err, ErrNativeStop) {
					t.Fatal("unconfirmed native shutdown claimed a safe stop", err)
				}
				state := native.Snapshot()
				if state.Call == nil || scenario != "changed generation during read" && !state.Unknown {
					t.Fatal("unconfirmed stop discarded the retained call")
				}
				_ = native.Close(t.Context())
			})
		})
	}
}
