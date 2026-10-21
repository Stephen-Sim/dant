package work

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func (value *Engine) Steer(ctx context.Context, conversationID, expectedTurnID, text, replyTo string) (json.RawMessage, error) {
	if contracts.TrimText(text) == "" {
		return nil, store.ErrInvalidState
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	value.mu.Lock()
	active := value.active
	call := value.CallSnapshot()
	if value.closed || value.maintenance || value.takeover || value.acquiring || active == nil || !value.currentLocked(active) || !active.startAcknowledged || active.turnID != expectedTurnID || active.conversationID != conversationID || active.stopRequested || active.finishing || active.unknown || call != nil && call.Provider == "subscription" || len(value.pendingFollowups) >= MaxPendingFollowups {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	if replyTo != "" {
		if _, err := value.store.Message(replyTo); err != nil {
			value.mu.Unlock()
			return nil, ErrStaleOwner
		}
	}
	message, err := value.store.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleUser, Text: contracts.TrimText(text), ReplyTo: contracts.Some(replyTo), Attachments: []contracts.Attachment{}, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft))})
	if err != nil {
		value.mu.Unlock()
		return nil, err
	}
	value.pendingFollowups[message.ID] = true
	value.workers.Add(1)
	result := make(chan voiceTaskResult, 1)
	go func() {
		defer value.workers.Done()
		receipt, err := value.followup(value.ctx, message, expectedTurnID, true)
		result <- voiceTaskResult{value: receipt, err: err}
	}()
	value.changeLocked()
	value.mu.Unlock()
	select {
	case receipt := <-result:
		return receipt.value, receipt.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-value.ctx.Done():
		return nil, ErrClosed
	}
}
