package runtime

func isAccountEvent(event Event) bool {
	return event.Method == "account/updated" || event.Method == "account/login/completed"
}

func (value *LocalWorker) changed() {
	if value.options.Changed != nil {
		value.options.Changed()
	}
}

// Authentication can finish before any task or voice thread has been opened.
// This connection-owned monitor observes only account notifications and never
// admits work, creates a thread, or consumes the Engine's observer subscription.
func (value *LocalWorker) monitorAccount(rpc *RPC, generation uint64, executor *Executor, events <-chan Event, unsubscribe func()) {
	defer value.monitors.Done()
	defer unsubscribe()
	defer value.disconnected(rpc, generation, executor)

	for {
		select {
		case <-value.ctx.Done():
			return
		case _, open := <-events:
			if !open {
				return
			}
			account, err := rpc.Request(value.ctx, "account/read", nil)
			if err != nil {
				if rpc.Closed() {
					return
				}
				continue
			}

			value.mu.Lock()
			current := !value.closed && value.generation == generation && value.rpc == rpc
			if current {
				value.account = account
			}
			value.mu.Unlock()
			if current {
				value.changed()
			}
		}
	}
}
