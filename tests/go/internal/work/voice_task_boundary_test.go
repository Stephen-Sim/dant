package work

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type unavailableVoiceWorker struct{ *fakeWorker }

func (unavailableVoiceWorker) Snapshot() contracts.WorkerState {
	return contracts.WorkerState{Status: contracts.ConnectionStatusOffline}
}

func TestPrivateVoiceAdmissionHonorsOfflineAndInMemoryCapacityBeforePersisting(t *testing.T) {
	for _, kind := range []string{"offline", "private capacity"} {
		t.Run(kind, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "api"}}
			want := runtime.ErrDisconnected
			if kind == "offline" {
				engine.worker = unavailableVoiceWorker{worker}
			} else {
				engine.mu.Lock()
				for index := range maxPrivateVoiceTasks {
					engine.voiceTasks[fmt.Sprintf("held-%d", index)] = &voiceTask{callID: "held", result: make(chan voiceTaskResult, 1)}
				}
				engine.mu.Unlock()
				want = runtime.ErrBackpressure
			}
			if _, err := engine.RunVoiceTask(t.Context(), "Current authorized input", ToolContext{CallID: "call", IsCurrent: func() bool { return true }}); !errors.Is(err, want) || len(engine.Snapshot().Queue) != 0 || len(persistence.Snapshot().Messages) != 0 {
				t.Fatal("unavailable private lane accepted durable or external work", kind, err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestExplicitPauseRetiresQueuedPrivateVoiceWithoutStartingItsModelTurn(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "api"}}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "active-before-voice")
	voiceResult := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(t.Context(), "Still queued private request", ToolContext{CallID: "call", IsCurrent: func() bool { return true }})
		voiceResult <- err
	}()
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return len(snapshot.Queue) == 1 })
	paused := make(chan error, 1)
	go func() { paused <- engine.Pause(t.Context()) }()
	interrupt := nextRequest(t, worker, "turn/interrupt")
	interrupt.result <- fakeResponse{value: contracts.RawObject{}}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "interrupted")); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, paused); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, voiceResult); !errors.Is(err, ErrPaused) || len(engine.Snapshot().Queue) != 0 || unconfirmedVoiceTasks(persistence.Snapshot()) || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("explicit pause submitted private queued work or retained an unknown sent fence", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestAcknowledgedPrivateVoiceRegistrationFailureRetainsItsUnknownOwner(t *testing.T) {
	for _, phase := range []string{"acknowledgement", "registration"} {
		t.Run(phase, func(t *testing.T) { assertPrivateVoicePersistenceFailureNotifies(t, phase) })
	}
}

func assertPrivateVoicePersistenceFailureNotifies(t *testing.T, phase string) {
	t.Helper()
	fault := &workPersistenceFault{match: func(state contracts.State) bool {
		if phase == "registration" {
			return len(state.WorkTasks) != 0
		}
		var fences []voiceTaskFence
		return json.Unmarshal(state.Extra[voiceTaskFenceKey], &fences) == nil && len(fences) == 1 && fences[0].Submission == contracts.SubmissionStatusConfirmed
	}}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "api"}}
	done := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(t.Context(), "Exactly one entrusted private task", ToolContext{CallID: "call", IsCurrent: func() bool { return true }})
		done <- err
	}()
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	start := nextRequest(t, worker, "turn/start")
	changes, unsubscribe := engine.Subscribe()
	defer unsubscribe()
	fault.armed.Store(true)
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("accepted-private-turn")})}}
	select {
	case <-changes:
	case <-time.After(time.Second):
		snapshot := engine.Snapshot()
		t.Fatalf("failed acknowledgement/registration was not published: failures=%d paused=%t", fault.failures.Load(), snapshot.Executor.Paused)
	}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.Status == contracts.TaskStatusUnknown && snapshot.Executor.Paused
	})
	if fault.failures.Load() != 1 || !unconfirmedVoiceTasks(persistence.Snapshot()) || len(persistence.Snapshot().WorkTasks) != 0 || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("unpersisted private registration invented durable success or discarded its sent fence")
	}
	if _, ok := engine.ToolScope(); ok {
		t.Fatal("unconfirmed acknowledged owner retained side-effect authority")
	}
	engine.Wake()
	assertWorkerQuiet(t, worker)
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); !errors.Is(err, ErrClosed) {
		t.Fatal("closing an unconfirmed private waiter invented its terminal result", err)
	}
}

func TestQueuedPrivateRetirementReportsCorruptPersistenceAndNeverRetriesTheRequest(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "api"}}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "unrelated-active-turn")
	done := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(t.Context(), "Queued input", ToolContext{CallID: "call", IsCurrent: func() bool { return true }})
		done <- err
	}()
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return len(snapshot.Queue) == 1 })
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error { state.Extra[voiceTaskFenceKey] = raw(true); return nil }); err != nil {
		t.Fatal(err)
	}
	if err := engine.ContinueVoiceTasks("call"); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("corrupt private receipt was silently treated as retired", err)
	}
	if err := awaitWorkAction(t, done); !errors.Is(err, ErrPaused) || !unconfirmedVoiceTasks(persistence.Snapshot()) || len(engine.Snapshot().Queue) != 0 || !owner.IsCurrent() {
		t.Fatal("known unsent private retirement replayed work or cleared corrupt evidence", err)
	}
	assertWorkerQuiet(t, worker)
}
