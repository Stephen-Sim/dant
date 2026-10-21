package work

import (
	"context"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type guardedWorker interface {
	RequestGuarded(context.Context, string, contracts.RawObject, func() error) (contracts.RawObject, error)
}

func (value *Engine) requestOwned(ctx context.Context, method string, params contracts.RawObject, isCurrent func() bool) (contracts.RawObject, error) {
	guard := func() error {
		if isCurrent != nil && !isCurrent() {
			return ErrStaleOwner
		}
		return nil
	}
	if worker, ok := value.worker.(guardedWorker); ok {
		return worker.RequestGuarded(ctx, method, params, guard)
	}
	if err := guard(); err != nil {
		return nil, err
	}
	return value.worker.Request(ctx, method, params)
}

// InjectReference appends quoted history without inference. Its caller owns a
// durable pending/submitted/unknown fence and must never replay an unknown RPC.
func (value *Engine) InjectReference(ctx context.Context, text string, isCurrent func() bool) (contracts.RawObject, error) {
	if isCurrent == nil || !isCurrent() {
		return nil, ErrStaleOwner
	}
	conversationID := value.store.ConversationID()
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return nil, ErrClosed
	}
	value.referencePending++
	value.mu.Unlock()
	defer func() {
		value.mu.Lock()
		value.referencePending--
		value.changeLocked()
		value.mu.Unlock()
		value.Wake()
	}()

	select {
	case value.referenceGate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-value.ctx.Done():
		return nil, ErrClosed
	}
	defer func() { <-value.referenceGate }()
	current := func() bool {
		return isCurrent() && value.store.ConversationID() == conversationID
	}
	if !current() {
		return nil, ErrStaleOwner
	}
	threadID, err := value.Thread(ctx)
	if err != nil {
		return nil, err
	}
	if !current() {
		return nil, ErrStaleOwner
	}
	result, err := value.requestOwned(ctx, "thread/inject_items", contracts.RawObject{
		"threadId": raw(threadID),
		"items": raw([]contracts.RawObject{{
			"type":    raw("message"),
			"role":    raw("user"),
			"content": raw([]contracts.RawObject{{"type": raw("input_text"), "text": raw(value.redact(text))}}),
		}}),
	}, current)
	if err != nil {
		return nil, err
	}
	if !current() {
		return nil, ErrStaleOwner
	}
	return result, nil
}

func (value *Engine) InstructionsContext(ctx context.Context) (string, error) {
	return value.buildInstructions(ctx, value.store.Snapshot())
}

func (value *Engine) InvalidateInstructions() {
	value.mu.Lock()
	value.loaded = false
	value.mu.Unlock()
	value.Change()
}

func (value *Engine) InvalidateContext() { value.InvalidateInstructions() }

// ConversationTransaction owns a short local persistence transaction. The
// callback must not call an Engine method or perform an external operation.
func (value *Engine) ConversationTransaction(ctx context.Context, conversationID string, operation func(context.Context) error) error {
	value.mu.Lock()
	if value.closed || value.maintenance {
		value.mu.Unlock()
		return ErrClosed
	}
	if err := ctx.Err(); err != nil {
		value.mu.Unlock()
		return err
	}
	if conversationID == "" || value.store.ConversationID() != conversationID {
		value.mu.Unlock()
		return ErrStaleOwner
	}
	err := operation(ctx)
	if err == nil {
		value.changeLocked()
	}
	value.mu.Unlock()
	if err == nil {
		value.Wake()
	}
	return err
}

// ToolTransaction fences a short local persistence operation to its execution
// owner. The callback must not call Engine methods or perform external I/O.
func (value *Engine) ToolTransaction(ctx context.Context, owner ToolContext, operation func(context.Context) error) error {
	if operation == nil {
		return ErrStaleOwner
	}
	value.mu.Lock()
	if value.closed || value.maintenance || value.takeover || value.acquiring || ctx.Err() != nil {
		value.mu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrStaleOwner
	}
	conversationID := value.store.ConversationID()
	if owner.ConversationID != "" && owner.ConversationID != conversationID {
		value.mu.Unlock()
		return ErrStaleOwner
	}
	if owner.TurnID == "" && owner.CallID != "" {
		call := value.CallSnapshot()
		if call == nil || call.ID != owner.CallID || call.Provider != "api" {
			value.mu.Unlock()
			return ErrStaleOwner
		}
	} else {
		active := value.active
		if active == nil || !value.currentLocked(active) || !active.startAcknowledged || active.stopRequested || active.finishing || active.unknown || active.turnID != owner.TurnID || active.threadID != owner.ThreadID || active.conversationID != owner.ConversationID {
			value.mu.Unlock()
			return ErrStaleOwner
		}
	}
	err := operation(ctx)
	if err == nil {
		value.changeLocked()
	}
	value.mu.Unlock()
	if err == nil {
		value.Wake()
	}
	return err
}

func (value *Engine) PreferenceTransaction(ctx context.Context, conversationID string, requiresIdle bool, operation func(context.Context) error) error {
	return value.ConversationTransaction(ctx, conversationID, func(ctx context.Context) error {
		if requiresIdle && (value.active != nil || value.callReservation != nil || value.openingThread || value.referencePending > 0 || len(value.pendingFollowups) > 0 || value.CallSnapshot() != nil || value.options.Calls != nil && value.options.Calls.PendingWork()) {
			return ErrBusy
		}
		return operation(ctx)
	})
}
