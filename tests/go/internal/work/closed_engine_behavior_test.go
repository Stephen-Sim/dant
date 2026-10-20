package work

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type closedSubscriptionWorker struct {
	*fakeWorker
	subscriptions atomic.Int32
}

func (worker *closedSubscriptionWorker) SubscribeEvents() (<-chan runtime.Event, func(), error) {
	worker.subscriptions.Add(1)
	return worker.fakeWorker.SubscribeEvents()
}

func TestClosedEngineJoinsItsSubscribersAndRejectsEveryNewExecutionAdmission(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	changes, cancelChanges := engine.Subscribe()
	signals, cancelSignals, err := engine.SubscribeSignals()
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	observed := &closedSubscriptionWorker{fakeWorker: worker}
	engine.worker = observed
	for range changes {
	}
	for range signals {
	}
	cancelSignals()
	cancelSignals()
	cancelChanges()
	cancelChanges()
	if _, _, err := engine.SubscribeSignals(); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine accepted a new signal subscription", err)
	}
	late, cancelLate := engine.Subscribe()
	defer cancelLate()
	if _, open := <-late; open {
		t.Fatal("closed engine left a new state subscriber waiting forever")
	}
	if err := engine.Handle(context.Background(), runtime.Event{Method: "item/started"}); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine consumed a provider execution event", err)
	}
	if err := engine.Pause(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine accepted a new pause transition", err)
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "late input"}); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine persisted a new user admission", err)
	}
	if _, err := engine.ClearCompletedProgress(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal("closed engine altered completed progress", err)
	}
	if err := engine.SetProgressPriority(context.Background(), "missing", store.ProgressTask, contracts.TaskPriorityHigh); !errors.Is(err, runtime.ErrBackpressure) {
		t.Fatal("closed engine mutated progress priority", err)
	}
	if _, err := engine.Thread(context.Background()); !errors.Is(err, ErrClosed) || observed.subscriptions.Load() != 0 {
		t.Fatal("closed engine opened another executor thread", err)
	}
	if len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("rejected closed-engine actions changed durable history")
	}
	assertWorkerQuiet(t, worker)
}

func TestEngineAndSupervisorRequireExplicitLiveDependencies(t *testing.T) {
	if _, err := New(context.Background(), nil, nil, Options{}); !errors.Is(err, ErrClosed) {
		t.Fatal("engine was constructed without persistence and an execution capability", err)
	}
	engine, persistence, _ := engineFixture(t)
	for _, options := range []SupervisorOptions{{}, {Interval: -1}} {
		if _, err := NewSupervisor(nil, engine, persistence, options); !errors.Is(err, ErrClosed) {
			t.Fatal("supervisor accepted a missing owner context", err)
		}
	}
	if _, err := NewSupervisor(context.Background(), engine, persistence, SupervisorOptions{Interval: -1}); !errors.Is(err, ErrClosed) {
		t.Fatal("supervisor accepted an invalid timer interval", err)
	}
}
