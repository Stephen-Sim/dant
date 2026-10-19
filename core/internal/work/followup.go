package work

import (
	"context"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (value *Engine) Followup(ctx context.Context, message *contracts.ChatMessage, expectedTurnID string) (json.RawMessage, error) {
	return value.followup(ctx, message, expectedTurnID, false)
}

func (value *Engine) followup(ctx context.Context, message *contracts.ChatMessage, expectedTurnID string, reserved bool) (json.RawMessage, error) {
	if message == nil {
		return nil, ErrStaleOwner
	}
	value.mu.Lock()
	active := value.active
	if value.closed || active == nil || !value.currentLocked(active) || !active.startAcknowledged || active.turnID != expectedTurnID || active.finishing || active.stopRequested || active.unknown || value.takeover || value.acquiring || value.pendingFollowups[message.ID] && !reserved {
		if reserved {
			delete(value.pendingFollowups, message.ID)
			value.changeLocked()
			value.Wake()
		}
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	if !reserved && len(value.pendingFollowups) >= MaxPendingFollowups {
		value.mu.Unlock()
		return nil, ErrBusy
	}
	value.pendingFollowups[message.ID] = true
	value.mu.Unlock()
	defer func() {
		value.mu.Lock()
		delete(value.pendingFollowups, message.ID)
		value.changeLocked()
		value.mu.Unlock()
		value.Wake()
	}()
	active.steer.Lock()
	defer active.steer.Unlock()
	if !value.current(active) {
		return nil, ErrStaleOwner
	}
	if _, err := value.store.Update(ctx, message.ID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusRunning), "submission": raw(contracts.SubmissionStatusPreparing), "parentTaskId": raw(active.messageID), "pauseReason": json.RawMessage("null")})); err != nil {
		return nil, err
	}
	input, err := value.prepareInput(active, message)
	if err != nil {
		return nil, err
	}
	value.mu.Lock()
	if !value.currentLocked(active) || active.stopRequested || active.unknown {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	value.mu.Unlock()
	if _, err = value.store.Update(value.ctx, message.ID, patch(contracts.RawObject{"submission": raw(contracts.SubmissionStatusSubmitting)})); err != nil {
		return nil, err
	}
	_, err = value.requestOwned(active.prepare, "turn/steer", contracts.RawObject{"threadId": raw(active.threadID), "expectedTurnId": raw(expectedTurnID), "input": input}, func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return value.currentLocked(active) && !active.stopRequested && !active.unknown && active.turnID == expectedTurnID
	})
	if err != nil {
		unknown := operationUnknown(err)
		value.mu.Lock()
		if unknown {
			active.unknown = true
			value.paused = true
		}
		value.mu.Unlock()
		submission := contracts.SubmissionStatusNotSubmitted
		if unknown {
			submission = contracts.SubmissionStatusUnknown
		}
		_, _ = value.store.Update(value.ctx, message.ID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusPaused), "submission": raw(submission), "unknownOutcome": raw(unknown), "pauseReason": raw("submission-unknown")}))
		return nil, err
	}
	if _, err = value.store.Update(value.ctx, message.ID, patch(contracts.RawObject{"submission": raw(contracts.SubmissionStatusConfirmed), "turnId": raw(expectedTurnID), "executorConfirmedAt": raw(value.Timestamp())})); err != nil {
		return nil, err
	}
	value.mu.Lock()
	if !value.currentLocked(active) || active.turnID != expectedTurnID {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	active.messageIDs = append(active.messageIDs, message.ID)
	active.waiting = false
	active.planWaiting = false
	active.humanResponse = true
	value.changeLocked()
	value.mu.Unlock()
	return raw(contracts.RawObject{"queued": raw(false), "turnId": raw(expectedTurnID)}), nil
}
