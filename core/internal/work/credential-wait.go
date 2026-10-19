package work

import (
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func (value *Engine) BeginCredentialWait(owner ToolContext) (func(), error) {
	if owner.IsCurrent == nil || !owner.IsCurrent() {
		return nil, ErrStaleOwner
	}
	if owner.TurnID == "" && owner.CallID != "" {
		call := value.CallSnapshot()
		if call == nil || call.ID != owner.CallID || call.Provider != "api" {
			return nil, ErrStaleOwner
		}
		return func() {}, nil
	}
	value.mu.Lock()
	active := value.active
	if active == nil || !value.currentLocked(active) || active.turnID != owner.TurnID || active.threadID != owner.ThreadID || active.conversationID != owner.ConversationID || !active.startAcknowledged || active.stopRequested || active.finishing || active.unknown {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	active.credentialWaits++
	if err := value.syncWaitingLocked(active); err != nil {
		active.credentialWaits--
		value.mu.Unlock()
		return nil, err
	}
	if (active.nativeBackground || active.attemptID != "") && !active.credentialNotified {
		text := i18n.Translate(value.store.Snapshot().Settings.Language, "I need a credential to continue this task. Please complete the secure credential form in chat.", "继续这个任务需要登录凭据，请填写聊天中的安全凭据表单。")
		if err := value.publishBlockerLocked(active, text, "credential"); err != nil {
			active.credentialWaits--
			_ = value.syncWaitingLocked(active)
			value.mu.Unlock()
			return nil, err
		}
		active.credentialNotified = true
	}
	value.changeLocked()
	value.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			value.mu.Lock()
			defer value.mu.Unlock()
			if !value.currentLocked(active) || active.stopRequested || active.finishing || active.unknown {
				return
			}
			active.credentialWaits = max(0, active.credentialWaits-1)
			if active.credentialWaits == 0 {
				active.credentialNotified = false
			}
			if err := value.syncWaitingLocked(active); err != nil {
				value.signalLocked("notice", raw("The task waiting state could not be saved."))
			}
			value.changeLocked()
		})
	}, nil
}

func (value *Engine) syncWaitingLocked(active *execution) error {
	status := contracts.TaskStatusRunning
	if active.waiting || active.planWaiting || active.credentialWaits > 0 {
		status = contracts.TaskStatusWaitingUser
	}
	return value.store.Mutate(value.ctx, func(state *contracts.State) error {
		if state.ConversationID != active.conversationID {
			return ErrStaleOwner
		}
		for _, id := range active.messageIDs {
			if message, err := store.FindMessage(state, id); err == nil {
				message.Status = contracts.Some(contracts.MessageStatus(status))
			}
		}
		return nil
	})
}
