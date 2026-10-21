package work

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const (
	ContinuationChangeDelay   = 5 * time.Second
	ContinuationCheckInterval = 30 * time.Second
	ContinuationFailureDelay  = 30 * time.Second
	continuationFailureNotice = "Unfinished work could not be continued. Its saved state was preserved."
)

type ContinuationEngine interface {
	CanContinueRegisteredWork() bool
	ContinueRegisteredWork(context.Context, string, ContinueOptions) (json.RawMessage, error)
	Subscribe() (<-chan struct{}, func())
}

type SupervisorOptions struct {
	Now      func() time.Time
	Interval time.Duration
	Notice   func(string)
}

type Supervisor struct {
	mu                       sync.Mutex
	ctx                      context.Context
	cancel                   context.CancelFunc
	engine                   ContinuationEngine
	store                    *store.Store
	options                  SupervisorOptions
	started, closed, running bool
	retryAt                  float64
	failures                 map[string]string
	done                     chan struct{}
}

func NewSupervisor(ctx context.Context, engine ContinuationEngine, persistence *store.Store, options SupervisorOptions) (*Supervisor, error) {
	if ctx == nil || engine == nil || persistence == nil {
		return nil, ErrClosed
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Interval == 0 {
		options.Interval = ContinuationCheckInterval
	}
	if options.Interval <= 0 {
		return nil, ErrClosed
	}
	owner, cancel := context.WithCancel(ctx)
	return &Supervisor{ctx: owner, cancel: cancel, engine: engine, store: persistence, options: options, failures: make(map[string]string), done: make(chan struct{})}, nil
}

func continuationPriority(priority contracts.TaskPriority) int {
	switch priority {
	case contracts.TaskPriorityHigh:
		return 0
	case contracts.TaskPriorityLow:
		return 2
	default:
		return 1
	}
}

func continuationDue(record *contracts.WorkRecord) float64 {
	if record.Continuation != nil && record.Continuation.NextAt.Present && !record.Continuation.NextAt.Null {
		return record.Continuation.NextAt.Value
	}
	return record.ExecutionEndedAt.Value + float64(ContinuationChangeDelay/time.Millisecond)
}

func supervisorCandidate(state contracts.State, at float64) *contracts.WorkRecord {
	var selected *contracts.WorkRecord
	for index := range state.WorkTasks {
		record := &state.WorkTasks[index]
		if !workstate.Eligible(record, at) {
			continue
		}
		if selected == nil || continuationPriority(record.ProgressPriority.Value) < continuationPriority(selected.ProgressPriority.Value) || continuationPriority(record.ProgressPriority.Value) == continuationPriority(selected.ProgressPriority.Value) && continuationDue(record) < continuationDue(selected) {
			selected = record
		}
	}
	return selected
}

func continuationFailureFingerprint(record *contracts.WorkRecord) string {
	phase := contracts.ContinuationDispatchPhase("")
	invalid := false
	if record.Continuation != nil {
		invalid = record.Continuation.Invalid
		if record.Continuation.Dispatch != nil {
			phase = record.Continuation.Dispatch.Phase
		}
	}
	return string(raw([]string{record.TurnID, string(record.Status), record.PauseReason.Value, workstate.Checkpoint(record.Plan), string(phase), string(raw(invalid))}))
}

func actionableContinuationFailure(record *contracts.WorkRecord) bool {
	return record != nil && (record.Status == contracts.WorkStatusUnknown || record.Status == contracts.WorkStatusFailed || record.Continuation != nil && (record.Continuation.Invalid || record.Continuation.Dispatch != nil) || record.Status == contracts.WorkStatusPaused && (record.PauseReason.Value == "automatic-no-progress" || record.PauseReason.Value == "continuation-save-failed"))
}

// Tick asks the existing Engine for one exact continuation. A timer never owns
// execution or replaces a lost acknowledgement with another submission.
func (value *Supervisor) Tick(ctx context.Context) (json.RawMessage, error) {
	value.mu.Lock()
	if value.closed || value.running || value.ctx.Err() != nil {
		value.mu.Unlock()
		return nil, nil
	}
	value.running = true
	value.mu.Unlock()
	defer func() {
		value.mu.Lock()
		value.running = false
		value.mu.Unlock()
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	at := float64(value.options.Now().UnixMilli())
	state := value.store.Snapshot()
	value.mu.Lock()
	for id, fingerprint := range value.failures {
		record, err := store.FindWork(&state, id)
		if err != nil || continuationFailureFingerprint(record) != fingerprint {
			delete(value.failures, id)
		}
	}
	blocked := at < value.retryAt
	value.mu.Unlock()
	if blocked || !value.engine.CanContinueRegisteredWork() {
		return nil, nil
	}
	selected := supervisorCandidate(state, at)
	if selected == nil || !value.engine.CanContinueRegisteredWork() {
		return nil, nil
	}
	latest := value.store.Snapshot()
	current, err := store.FindWork(&latest, selected.ID)
	if err != nil || current.TurnID != selected.TurnID || !workstate.Eligible(current, float64(value.options.Now().UnixMilli())) {
		return nil, nil
	}
	result, err := value.engine.ContinueRegisteredWork(ctx, selected.ID, ContinueOptions{ExpectedTurnID: selected.TurnID})
	value.mu.Lock()
	notify := false
	if err == nil {
		delete(value.failures, selected.ID)
	} else if !value.closed && value.ctx.Err() == nil {
		value.retryAt = max(value.retryAt, float64(value.options.Now().Add(ContinuationFailureDelay).UnixMilli()))
		latest := value.store.Snapshot()
		record, lookupErr := store.FindWork(&latest, selected.ID)
		if lookupErr == nil && (record.TurnID == selected.TurnID || containsString(record.TurnIDs, selected.TurnID)) && actionableContinuationFailure(record) {
			fingerprint := continuationFailureFingerprint(record)
			if value.failures[selected.ID] != fingerprint {
				value.failures[selected.ID] = fingerprint
				notify = true
			}
		}
	}
	closed := value.closed
	value.mu.Unlock()
	if notify && value.options.Notice != nil {
		value.options.Notice(continuationFailureNotice)
	}
	if closed {
		return nil, nil
	}
	return result, err
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (value *Supervisor) Start() {
	value.mu.Lock()
	if value.closed || value.started {
		value.mu.Unlock()
		return
	}
	value.started = true
	value.mu.Unlock()
	go value.run()
}

func (value *Supervisor) run() {
	defer close(value.done)
	changes, unsubscribe := value.engine.Subscribe()
	defer unsubscribe()
	periodic := time.NewTicker(value.options.Interval)
	defer periodic.Stop()
	change := time.NewTimer(ContinuationChangeDelay)
	change.Stop()
	defer change.Stop()
	for {
		select {
		case <-value.ctx.Done():
			return
		case _, open := <-changes:
			if !open {
				return
			}
			change.Reset(ContinuationChangeDelay)
		case <-periodic.C:
			_, _ = value.Tick(value.ctx)
		case <-change.C:
			_, _ = value.Tick(value.ctx)
		}
	}
}

func (value *Supervisor) Close(ctx context.Context) error {
	value.mu.Lock()
	if !value.closed {
		value.closed = true
		value.cancel()
		if !value.started {
			close(value.done)
		}
	}
	value.mu.Unlock()
	select {
	case <-value.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
