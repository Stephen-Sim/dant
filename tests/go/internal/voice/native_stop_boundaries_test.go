package voice

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type nativeReadBoundary struct {
	work.Worker
	result contracts.RawObject
	err    error
}

func (worker nativeReadBoundary) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	if method == "thread/read" {
		return worker.result, worker.err
	}
	return worker.Worker.Request(ctx, method, params)
}

func TestNativeStopRequiresConsistentReadbackBeforeRetiringMedia(t *testing.T) {
	for _, test := range []struct {
		name   string
		result contracts.RawObject
		err    error
	}{
		{"read failure", nil, errors.New("isolated readback failure")},
		{"foreign thread", object(map[string]any{"thread": map[string]any{"id": "foreign", "turns": []any{}}}), nil},
		{"missing turns", object(map[string]any{"thread": map[string]any{"id": "shared-thread", "turns": nil}}), nil},
		{"invalid turn", object(map[string]any{"thread": map[string]any{"id": "shared-thread", "turns": []any{map[string]any{"id": "turn", "status": "unknown"}}}}), nil},
		{"duplicate turn", object(map[string]any{"thread": map[string]any{"id": "shared-thread", "turns": []any{map[string]any{"id": "turn", "status": "completed"}, map[string]any{"id": "turn", "status": "completed"}}}}), nil},
		{"untracked active turn", object(map[string]any{"thread": map[string]any{"id": "shared-thread", "turns": []any{map[string]any{"id": "untracked", "status": "inProgress"}}}}), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			native, _, _, _ := nativeFixture(t)
			native.options.Worker = nativeReadBoundary{Worker: native.options.Worker, result: test.result, err: test.err}
			startNativeFixture(t, native)
			if err := native.Stop(t.Context(), "call-one"); !errors.Is(err, ErrNativeStop) {
				t.Fatal("unconfirmed readback was reported as stopped", err)
			}
			state := native.Snapshot()
			if !state.Unknown || state.Call == nil || state.Call.Status != contracts.VoiceCallStatusStopUnconfirmed || state.Error == nil || *state.Error != ErrNativeStop.Error() {
				t.Fatal("readback ambiguity discarded the current call owner")
			}
			if err := native.Close(t.Context()); !errors.Is(err, ErrNativeStop) {
				t.Fatal("unknown stop result was forgotten at shutdown", err)
			}
		})
	}
}

func TestNativeStopConfirmsIdleHandoffsAndKeepsBackgroundWorkUntilShutdown(t *testing.T) {
	for _, idle := range []bool{false, true} {
		native, worker, _, _ := nativeFixture(t)
		startNativeFixture(t, native)
		native.mu.Lock()
		s := native.session
		s.handoffs["handoff"] = &nativeHandoff{itemID: "item"}
		native.mu.Unlock()
		worker.mu.Lock()
		worker.readStatus = "active"
		if idle {
			worker.readStatus = "idle"
		}
		worker.mu.Unlock()
		err := native.Stop(t.Context(), "call-one")
		if idle {
			if err != nil || !s.handoffs["handoff"].idleConfirmed || native.Call() != nil {
				t.Fatal("readback-proven idle handoff remained unresolved", err)
			}
		} else if !errors.Is(err, ErrNativeStop) {
			t.Fatal("active handoff without execution identity was forgotten", err)
		}
		_ = native.Close(t.Context())
	}
	native, worker, engine, _ := nativeFixture(t)
	startNativeFixture(t, native)
	native.mu.Lock()
	native.session.turns["accepted-turn"] = &nativeTurn{owner: work.ToolContext{TurnID: "accepted-turn", ThreadID: "shared-thread", WorkID: "work"}}
	native.mu.Unlock()
	worker.mu.Lock()
	worker.turns = []contracts.RawObject{object(map[string]any{"id": "accepted-turn", "status": "inProgress"})}
	worker.mu.Unlock()
	if err := native.Stop(t.Context(), "call-one"); err != nil || engine.continued.Load() != 1 || !native.PendingWork() {
		t.Fatal("hangup did not preserve entrusted background work", err)
	}
	if err := native.Stop(t.Context(), "call-one"); err != nil || engine.continued.Load() != 1 {
		t.Fatal("duplicate hangup continued work twice", err)
	}
	if err := native.Close(t.Context()); err != nil || engine.paused.Load() != 1 || native.Call() != nil {
		t.Fatal("application shutdown did not pause and join background work", err)
	}
}
