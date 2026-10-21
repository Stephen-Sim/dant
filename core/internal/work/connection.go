package work

import "context"

// The actor lock protects this eligibility check and reservation acquisition.
// Backup requires an empty queue; explicit connection can recover queued work.
func (value *Engine) idleReservationUnavailableLocked(requireEmptyQueue bool) bool {
	if value.closed || value.maintenance || value.takeover || value.acquiring {
		return true
	}
	if value.active != nil || value.openingThread || value.referencePending > 0 ||
		len(value.pendingFollowups) > 0 || len(value.pendingRequests) > 0 ||
		requireEmptyQueue && len(value.queue) > 0 {
		return true
	}

	return value.callReservation != nil || value.CallSnapshot() != nil ||
		value.options.Calls != nil && value.options.Calls.PendingWork()
}

// ConnectionTransaction owns the short connection/login/logout mutation window.
// Unlike backup capture, the operation is expected to replace the Worker
// generation. It reserves admission without holding the actor during RPC and
// never changes an explicit user pause or retries an unknown operation.
func (value *Engine) ConnectionTransaction(ctx context.Context, requireEmptyQueue bool, operation func(context.Context) error) error {
	if operation == nil {
		return ErrBusy
	}
	value.mu.Lock()
	if err := ctx.Err(); err != nil {
		value.mu.Unlock()
		return err
	}
	if value.idleReservationUnavailableLocked(requireEmptyQueue) {
		value.mu.Unlock()
		return ErrBusy
	}
	if value.UnconfirmedStop() {
		value.mu.Unlock()
		return ErrUnknown
	}
	conversationID := value.store.ConversationID()
	value.maintenance = true
	value.changeLocked()
	value.mu.Unlock()

	defer func() {
		value.mu.Lock()
		value.maintenance = false
		value.changeLocked()
		value.mu.Unlock()
		value.Wake()
	}()
	if err := operation(ctx); err != nil {
		return err
	}
	if value.store.ConversationID() != conversationID {
		return ErrStaleOwner
	}
	return nil
}
