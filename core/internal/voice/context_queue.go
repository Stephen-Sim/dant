package voice

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/google/uuid"
)

var ErrContextUnknown = errors.New("live_context_unconfirmed")
var ErrContextRejected = errors.New("live_context_rejected")

type ContextInput struct{ Key, Text, MessageID, Kind, ContextID string }
type ContextResult struct {
	CallID    string                      `json:"callId"`
	ContextID string                      `json:"contextId"`
	MessageID string                      `json:"messageId,omitempty"`
	Kind      string                      `json:"kind,omitempty"`
	Status    contracts.LiveContextStatus `json:"status"`
	Error     string                      `json:"error,omitempty"`
}

type ContextQueueOptions struct {
	CallID     string
	IsCurrent  func() bool
	Send       func(context.Context, ContextInput) error
	Timeout    time.Duration
	MaxPending int
	OnResult   func(ContextResult)
}

type pendingContext struct {
	input ContextInput
	done  chan ContextResult
}

type ContextQueue struct {
	mu                sync.Mutex
	options           ContextQueueOptions
	pending           []*pendingContext
	closed, uncertain bool
	wake              chan struct{}
	done              chan struct{}
	cancel            context.CancelFunc
	activeCancel      context.CancelFunc
}

func NewContextQueue(ctx context.Context, options ContextQueueOptions) (*ContextQueue, error) {
	if options.Timeout == 0 {
		options.Timeout = 5 * time.Second
	}
	if options.MaxPending == 0 {
		options.MaxPending = 32
	}
	if !captionID(options.CallID) || options.Send == nil || options.IsCurrent == nil || options.Timeout < time.Millisecond || options.Timeout > 30*time.Second || options.MaxPending < 1 || options.MaxPending > 32 {
		return nil, ErrCallInput
	}
	owned, cancel := context.WithCancel(ctx)
	queue := &ContextQueue{options: options, wake: make(chan struct{}, 1), done: make(chan struct{}), cancel: cancel}
	go queue.run(owned)
	return queue, nil
}

func (q *ContextQueue) result(item *pendingContext, status contracts.LiveContextStatus, reason string) ContextResult {
	value := ContextResult{q.options.CallID, item.input.ContextID, item.input.MessageID, item.input.Kind, status, reason}
	if q.options.OnResult != nil {
		func() { defer func() { _ = recover() }(); q.options.OnResult(value) }()
	}
	item.done <- value
	close(item.done)
	return value
}

func (q *ContextQueue) Enqueue(ctx context.Context, input ContextInput) ContextResult {
	input.ContextID = uuid.NewString()
	item := &pendingContext{input: input, done: make(chan ContextResult, 1)}
	if ctx.Err() != nil {
		return ContextResult{CallID: q.options.CallID, ContextID: input.ContextID, MessageID: input.MessageID, Kind: input.Kind, Status: contracts.LiveContextStatusCancelled}
	}
	current := q.options.IsCurrent()
	q.mu.Lock()
	if q.closed || !current {
		q.mu.Unlock()
		return q.result(item, contracts.LiveContextStatusCancelled, "")
	}
	if q.uncertain {
		q.mu.Unlock()
		return q.result(item, contracts.LiveContextStatusUnknown, "An earlier live context submission is unconfirmed; it will not be retried.")
	}
	if input.Text == "" {
		q.mu.Unlock()
		return q.result(item, contracts.LiveContextStatusFailed, "The live context update is invalid.")
	}
	var replaced *pendingContext
	for index, prior := range q.pending {
		if prior.input.Key == input.Key {
			replaced = prior
			q.pending[index] = item
			break
		}
	}
	if replaced == nil {
		if len(q.pending) >= q.options.MaxPending {
			q.mu.Unlock()
			return q.result(item, contracts.LiveContextStatusFailed, "The live context queue is full.")
		}
		q.pending = append(q.pending, item)
	}
	q.mu.Unlock()
	if replaced != nil {
		q.result(replaced, "superseded", "")
	}
	select {
	case q.wake <- struct{}{}:
	default:
	}
	select {
	case result := <-item.done:
		return result
	case <-ctx.Done():
		return ContextResult{q.options.CallID, input.ContextID, input.MessageID, input.Kind, contracts.LiveContextStatusUnknown, "The live context submission was not confirmed."}
	}
}

func (q *ContextQueue) run(ctx context.Context) {
	defer close(q.done)
	for {
		select {
		case <-ctx.Done():
			q.closePending()
			return
		case <-q.wake:
		}
		for {
			current := q.options.IsCurrent()
			q.mu.Lock()
			if q.closed || len(q.pending) == 0 {
				q.mu.Unlock()
				break
			}
			item := q.pending[0]
			q.pending = q.pending[1:]
			if !current {
				q.mu.Unlock()
				q.result(item, contracts.LiveContextStatusCancelled, "")
				continue
			}
			bounded, cancel := context.WithTimeout(ctx, q.options.Timeout)
			q.activeCancel = cancel
			q.mu.Unlock()
			err := q.options.Send(bounded, item.input)
			expired := bounded.Err()
			cancel()
			current = q.options.IsCurrent()
			q.mu.Lock()
			q.activeCancel = nil
			closed := q.closed || !current
			q.mu.Unlock()
			status, reason := contracts.LiveContextStatusSubmitted, ""
			if closed {
				status = contracts.LiveContextStatusCancelled
			} else if err != nil || expired != nil {
				status = contracts.LiveContextStatusUnknown
				reason = "The live context submission was not confirmed."
				if errors.Is(err, ErrContextRejected) {
					status = contracts.LiveContextStatusFailed
				}
				if errors.Is(expired, context.DeadlineExceeded) {
					reason = "The live context submission timed out; it will not be retried."
				}
			}
			q.result(item, status, reason)
			if status == contracts.LiveContextStatusUnknown {
				q.mu.Lock()
				q.uncertain = true
				pending := q.pending
				q.pending = nil
				q.mu.Unlock()
				for _, next := range pending {
					q.result(next, contracts.LiveContextStatusUnknown, "An earlier live context submission is unconfirmed; it will not be retried.")
				}
				break
			}
		}
	}
}

func (q *ContextQueue) closePending() {
	q.mu.Lock()
	q.closed = true
	pending := q.pending
	q.pending = nil
	q.mu.Unlock()
	for _, item := range pending {
		q.result(item, contracts.LiveContextStatusCancelled, "")
	}
}

func (q *ContextQueue) Close(ctx context.Context) error {
	q.mu.Lock()
	q.closed = true
	cancel := q.activeCancel
	q.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	q.cancel()
	select {
	case <-q.done:
		return nil
	case <-ctx.Done():
		return ErrContextUnknown
	}
}
