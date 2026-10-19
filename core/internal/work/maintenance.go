package work

import "context"

func (value *Engine) MaintenanceActive() bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.maintenance
}

// MaintenanceTransaction reserves an idle execution boundary without holding
// the actor lock while a bounded backup stream is captured. Every writer must
// either use actor admission or invalidate the captured Store revision.
func (value *Engine) MaintenanceTransaction(ctx context.Context, operation func(context.Context, func() bool) error) error {
	if operation == nil {
		return ErrBusy
	}
	value.mu.Lock()
	if err := ctx.Err(); err != nil {
		value.mu.Unlock()
		return err
	}
	if value.idleReservationUnavailableLocked(true) {
		value.mu.Unlock()
		return ErrBusy
	}

	conversationID := value.store.ConversationID()
	revision := value.store.Revision()
	generation := value.worker.Snapshot().Generation
	epoch := value.epoch
	paused := value.paused
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

	current := func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return ctx.Err() == nil && !value.closed && value.maintenance &&
			value.epoch == epoch && value.paused == paused &&
			value.store.ConversationID() == conversationID && value.store.Revision() == revision &&
			value.worker.Snapshot().Generation == generation && value.active == nil &&
			len(value.queue) == 0 && value.CallSnapshot() == nil
	}
	if !current() {
		return ErrStaleOwner
	}
	if err := operation(ctx, current); err != nil {
		return err
	}
	if !current() {
		return ErrStaleOwner
	}
	return nil
}
