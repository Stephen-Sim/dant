package work

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type supervisorBehaviorEngine struct {
	mu                                     sync.Mutex
	changes                                chan struct{}
	checks, calls, subscriptions, releases int
	available                              bool
	continueWork                           func(context.Context, string, ContinueOptions) (json.RawMessage, error)
}

func (engine *supervisorBehaviorEngine) CanContinueRegisteredWork() bool {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.checks++
	return engine.available
}

func (engine *supervisorBehaviorEngine) ContinueRegisteredWork(ctx context.Context, id string, options ContinueOptions) (json.RawMessage, error) {
	engine.mu.Lock()
	engine.calls++
	callback := engine.continueWork
	engine.mu.Unlock()
	if callback != nil {
		return callback(ctx, id, options)
	}
	return json.RawMessage(`{"continued":true}`), nil
}

func (engine *supervisorBehaviorEngine) Subscribe() (<-chan struct{}, func()) {
	engine.mu.Lock()
	engine.subscriptions++
	engine.mu.Unlock()
	return engine.changes, func() {
		engine.mu.Lock()
		engine.releases++
		engine.mu.Unlock()
	}
}

func (engine *supervisorBehaviorEngine) counters() (int, int, int, int) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return engine.checks, engine.calls, engine.subscriptions, engine.releases
}

func TestSupervisorOwnsItsDebouncedAndPeriodicTimersAndJoinsAClosedSubscription(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		persistence, err := store.Open(t.TempDir(), store.Options{})
		if err != nil {
			t.Fatal(err)
		}
		defer persistence.Close()
		engine := &supervisorBehaviorEngine{changes: make(chan struct{}, 2), available: true}
		supervisor, err := NewSupervisor(context.Background(), engine, persistence, SupervisorOptions{Interval: time.Hour})
		if err != nil {
			t.Fatal(err)
		}
		defer supervisor.Close(context.Background())
		supervisor.Start()
		supervisor.Start()
		synctest.Wait()
		if checks, calls, subscriptions, _ := engine.counters(); checks != 0 || calls != 0 || subscriptions != 1 {
			t.Fatal("starting the supervisor immediately dispatched work or duplicated its timer owner")
		}

		engine.changes <- struct{}{}
		engine.changes <- struct{}{}
		synctest.Wait()
		time.Sleep(ContinuationChangeDelay - time.Millisecond)
		synctest.Wait()
		if checks, _, _, _ := engine.counters(); checks != 0 {
			t.Fatal("change notifications bypassed the existing debounce deadline")
		}
		time.Sleep(time.Millisecond)
		synctest.Wait()
		if checks, calls, _, _ := engine.counters(); checks != 1 || calls != 0 {
			t.Fatal("debounced empty-state check was lost or created execution")
		}
		time.Sleep(time.Hour - ContinuationChangeDelay)
		synctest.Wait()
		if checks, calls, _, _ := engine.counters(); checks != 2 || calls != 0 {
			t.Fatal("periodic checks duplicated execution or lost their timer")
		}

		close(engine.changes)
		synctest.Wait()
		if err := supervisor.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
		supervisor.Start()
		if _, _, subscriptions, releases := engine.counters(); subscriptions != 1 || releases != 1 {
			t.Fatal("closed subscription was leaked or restarted")
		}
	})
}

func TestSupervisorCloseIsBoundedWhileAnAdmissionIgnoresCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		persistence, err := store.Open(t.TempDir(), store.Options{})
		if err != nil {
			t.Fatal(err)
		}
		defer persistence.Close()
		savedUnfinished(t, persistence)
		entered, release := make(chan struct{}), make(chan struct{})
		engine := &supervisorBehaviorEngine{changes: make(chan struct{}), available: true}
		engine.continueWork = func(context.Context, string, ContinueOptions) (json.RawMessage, error) {
			close(entered)
			<-release
			return json.RawMessage(`{"continued":true}`), nil
		}
		supervisor, err := NewSupervisor(context.Background(), engine, persistence, SupervisorOptions{Interval: time.Second})
		if err != nil {
			t.Fatal(err)
		}
		supervisor.Start()
		synctest.Wait()
		time.Sleep(time.Second)
		<-entered
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := supervisor.Close(ctx); !errors.Is(err, context.Canceled) {
			t.Fatal("shutdown ignored the caller deadline while admission was unresolved", err)
		}
		if receipt, err := supervisor.Tick(context.Background()); receipt != nil || err != nil {
			t.Fatal("closed supervisor admitted additional work")
		}
		close(release)
		synctest.Wait()
		if err := supervisor.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, calls, subscriptions, releases := engine.counters(); calls != 1 || subscriptions != 1 || releases != 1 {
			t.Fatal("shutdown replayed an uncertain admission or leaked its observer")
		}
	})
}

func TestSupervisorNeverRetriesUnknownWorkAndDeduplicatesItsFixedFailureNotice(t *testing.T) {
	now := time.UnixMilli(100_000)
	persistence, err := store.Open(t.TempDir(), store.Options{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	workID, turnID := savedUnfinished(t, persistence)
	engine := &supervisorBehaviorEngine{changes: make(chan struct{}), available: true}
	engine.continueWork = func(ctx context.Context, id string, options ContinueOptions) (json.RawMessage, error) {
		if id != workID || options.ExpectedTurnID != turnID {
			t.Fatal("supervisor changed its exact selected work or turn")
		}
		if err := persistence.Mutate(ctx, func(state *contracts.State) error {
			record, err := store.FindWork(state, id)
			if err != nil {
				return err
			}
			record.Status = contracts.WorkStatusUnknown
			record.UnknownOutcome = true
			record.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return nil, ErrUnknown
	}
	notices := []string{}
	supervisor, err := NewSupervisor(context.Background(), engine, persistence, SupervisorOptions{
		Now:    func() time.Time { return now },
		Notice: func(text string) { notices = append(notices, text) },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close(context.Background())
	if _, err := supervisor.Tick(context.Background()); !errors.Is(err, ErrUnknown) {
		t.Fatal("unconfirmed continuation claimed success", err)
	}
	for _, advance := range []time.Duration{time.Millisecond, ContinuationFailureDelay, time.Hour} {
		now = now.Add(advance)
		if _, err := supervisor.Tick(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, calls, _, _ := engine.counters(); calls != 1 || len(notices) != 1 || notices[0] != continuationFailureNotice {
		t.Fatal("unknown work was resubmitted or its failure notice exposed arbitrary task content")
	}
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		record, err := store.FindWork(state, workID)
		if err != nil {
			return err
		}
		record.Status = contracts.WorkStatusContinuing
		record.UnknownOutcome = false
		record.Submission = contracts.Some(contracts.SubmissionStatusNotSubmitted)
		record.Continuation = &contracts.WorkContinuation{
			NextAt: contracts.Some(float64(now.UnixMilli())), LastCheckpoint: workstate.Checkpoint(record.Plan),
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.Tick(context.Background()); !errors.Is(err, ErrUnknown) {
		t.Fatal("explicitly reconciled work could not be admitted again", err)
	}
	if _, calls, _, _ := engine.counters(); calls != 2 || len(notices) != 2 {
		t.Fatal("a genuinely changed durable attempt reused stale failure suppression")
	}
}
