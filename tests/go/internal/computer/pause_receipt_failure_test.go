package computer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestPauseReceiptRejectsUnknownActionsAndFailedWritesWithoutLosingTheFence(t *testing.T) {
	bridge, _ := newHTTPContractBridge(t, nil)
	binding := mustBinding(t, bridge)
	if _, err := bridge.pauseReceipt(t.Context(), binding, "start"); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(bridge.options.DataDir, "vm-work-pause.json")
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for _, action := range []string{"unknown", "clear"} {
		operation := t.Context()
		if action == "clear" {
			operation = ctx
		}
		if _, err := bridge.pauseReceipt(operation, binding, action); !errors.Is(err, ErrPauseUnconfirmed) {
			t.Fatal("unknown or rejected durable mutation claimed successful reconciliation", err)
		}
		current, err := os.ReadFile(name)
		if err != nil || string(current) != string(before) {
			t.Fatal("failed receipt mutation lost the last durable uncertainty fence", err)
		}
	}
	if pending, err := bridge.pauseReceipt(t.Context(), binding, "read"); err != nil || !pending {
		t.Fatal("failed clearing made the unconfirmed operation safe to replay", err)
	}
}

func TestPauseCannotAcceptNewQueuedWorkAfterItsSecondStopAcknowledgement(t *testing.T) {
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	pauses := 0
	fixture.hook = func(writer http.ResponseWriter, request *http.Request, current *pauseProtocolFixture) {
		if request.URL.Path == "/api/tasks/pause" {
			pauses++
			if pauses == 2 {
				current.state.Queue = []string{"late-queued-request"}
				_, _ = io.WriteString(writer, `{"ok":true}`)
				return
			}
		}
		current.apply(writer, request)
	}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 2 {
		t.Fatal("late queued work was accepted as an independently idle executor", err)
	}
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 2 {
		t.Fatal("unknown pause was replayed instead of requiring reconciliation", err)
	}
}

func TestPauseRecognizesAHealthyUndispatchedContinuationAsSavedWork(t *testing.T) {
	fixture := &pauseProtocolFixture{state: pauseCallState()}
	fixture.state.WorkTasks[0].Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(float64(1000))}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); err != nil {
		t.Fatal("saved continuation without a dispatch was treated as an unknown external action", err)
	}
	state := fixture.snapshot()
	if state.Call != nil || state.WorkTasks[0].Status != contracts.WorkStatusPaused || state.WorkTasks[0].Continuation.Dispatch != nil {
		t.Fatal("pause discarded saved work or invented a continuation execution")
	}
}
