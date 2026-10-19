package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

func (gateway *Gateway) Start() {
	gateway.mu.Lock()
	if gateway.closed || !gateway.options.AutoPoll || !gateway.config.Enabled || gateway.config.Token == nil || gateway.loopDone != nil {
		gateway.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(gateway.ctx)
	done := make(chan struct{})
	gateway.loopCancel, gateway.loopDone = cancel, done
	gateway.mu.Unlock()
	go func() {
		var workers sync.WaitGroup
		workers.Add(2)
		go func() { defer workers.Done(); gateway.pollLoop(ctx) }()
		go func() { defer workers.Done(); gateway.outboundLoop(ctx) }()
		workers.Wait()
		gateway.mu.Lock()
		if gateway.loopDone == done {
			gateway.connected = false
		}
		gateway.mu.Unlock()
		close(done)
		gateway.changed()
	}()
}

func (gateway *Gateway) stopLoops(ctx context.Context) error {
	gateway.mu.Lock()
	cancel, done := gateway.loopCancel, gateway.loopDone
	if cancel != nil {
		cancel()
	}
	gateway.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ErrClosed
		}
	}
	gateway.mu.Lock()
	if gateway.loopDone == done {
		gateway.loopCancel, gateway.loopDone = nil, nil
		gateway.connected = false
	}
	gateway.mu.Unlock()
	return nil
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func (gateway *Gateway) pollLoop(ctx context.Context) {
	backoff := gateway.options.RetryBase
	verified := false
	for ctx.Err() == nil {
		gateway.mu.Lock()
		token := ""
		if gateway.config.Token != nil {
			token = *gateway.config.Token
		}
		gateway.mu.Unlock()
		var err error
		if !verified {
			var bot *Bot
			bot, err = gateway.verify(ctx, token, true)
			if err == nil && gateway.operation(ctx) == nil {
				gateway.mu.Lock()
				gateway.config.Bot = bot
				err = gateway.saveLocked(ctx)
				gateway.mu.Unlock()
				<-gateway.operations
				verified = err == nil
			}
		}
		if err == nil {
			err = gateway.PollOnce(ctx)
		}
		if ctx.Err() != nil {
			return
		}
		gateway.mu.Lock()
		if err == nil {
			gateway.connected = true
			if gateway.config.PollError != nil && gateway.config.LastError != nil && *gateway.config.PollError == *gateway.config.LastError {
				gateway.config.LastError = nil
			}
			gateway.config.PollError = nil
			backoff = gateway.options.RetryBase
		} else {
			gateway.connected = false
			gateway.config.PollError = pointer("Telegram could not be reached or returned an invalid response")
			gateway.config.LastError = gateway.config.PollError
		}
		saveErr := gateway.saveLocked(ctx)
		gateway.mu.Unlock()
		gateway.changed()
		gateway.Wake()
		if saveErr != nil {
			return
		}
		if err != nil {
			var operation *OperationError
			if errors.As(err, &operation) && (operation.Code == 401 || operation.Code == 403 || operation.Code == 409) {
				return
			}
			delay := backoff
			if operation != nil && operation.RetryAfter > delay {
				delay = operation.RetryAfter
			}
			if delay > 300*time.Second {
				delay = 300 * time.Second
			}
			if !wait(ctx, delay) {
				return
			}
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (gateway *Gateway) PollOnce(ctx context.Context) error {
	gateway.mu.Lock()
	config := gateway.config
	gateway.mu.Unlock()
	if !config.Enabled || config.Token == nil || config.Bot == nil {
		return nil
	}
	data, err := gateway.api(ctx, *config.Token, "getUpdates", raw(map[string]any{"offset": config.Offset, "limit": 20, "timeout": int(gateway.options.PollTimeout / time.Second), "allowed_updates": []string{"message"}}), "")
	if err != nil {
		return err
	}
	var updates []json.RawMessage
	if json.Unmarshal(data, &updates) != nil || updates == nil || len(updates) > 100 {
		return ErrIncoming
	}
	ordered := make([]Update, 0, len(updates))
	for _, rawUpdate := range updates {
		update, err := ReadUpdate(rawUpdate)
		if err == nil {
			ordered = append(ordered, update)
		}
	}
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].ID < ordered[b].ID })
	for _, update := range ordered {
		if err = gateway.Receive(ctx, update); err != nil {
			return err
		}
	}
	if len(updates) == 0 {
		wait(ctx, 200*time.Millisecond)
	}
	return nil
}

func (gateway *Gateway) outboundLoop(ctx context.Context) {
	for ctx.Err() == nil {
		wakeAt, err := gateway.Flush(ctx)
		if err != nil && ctx.Err() != nil {
			return
		}
		duration := 30 * time.Second
		if wakeAt > 0 {
			duration = min(duration, max(time.Millisecond, time.Duration(wakeAt-gateway.options.Now().UnixMilli())*time.Millisecond))
		}
		timer := time.NewTimer(duration)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-gateway.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
