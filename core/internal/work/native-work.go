package work

import (
	"context"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type NativeTurnInput struct {
	ConversationID string
	CallID         string
	ThreadID       string
	TurnID         string
	HandoffID      string
	MessageIDs     []string
	CapturedOwner  *ToolContext
}

func (value *Engine) ownerLocked(active *execution) ToolContext {
	owner := ToolContext{
		ConversationID: active.conversationID,
		MessageID:      active.messageID,
		MessageIDs:     append([]string{}, active.messageIDs...),
		WorkID:         active.workID,
		TurnID:         active.turnID,
		ThreadID:       active.threadID,
		CallID:         active.callID,
		Owner:          active.turnID,
	}
	owner.IsCurrent = func() bool {
		return value.Current(owner)
	}
	return owner
}

func (value *Engine) ToolScope() (ToolContext, bool) {
	value.mu.Lock()
	defer value.mu.Unlock()
	active := value.active
	if value.closed || value.takeover || value.acquiring || active == nil || !value.currentLocked(active) || !active.startAcknowledged || active.stopRequested || active.finishing || active.unknown || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
		return ToolContext{}, false
	}
	return value.ownerLocked(active), true
}

// AdoptNativeTurn consumes a voice owner's independently acknowledged handoff;
// unsolicited notifications alone can never call this admission capability.
func (value *Engine) AdoptNativeTurn(ctx context.Context, input NativeTurnInput) (ToolContext, error) {
	if err := ctx.Err(); err != nil {
		return ToolContext{}, err
	}
	if !workstate.ValidID(input.ConversationID, workstate.IDLength) || !workstate.ValidID(input.CallID, workstate.IDLength) || !workstate.ValidID(input.ThreadID, workstate.ReferenceIDLength) || !workstate.ValidID(input.TurnID, workstate.ReferenceIDLength) || !workstate.ValidID(input.HandoffID, workstate.ReferenceIDLength) {
		return ToolContext{}, ErrStaleOwner
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	state := value.store.Snapshot()
	if value.closed || value.maintenance || value.takeover || value.acquiring || value.paused || state.ConversationID != input.ConversationID || state.ThreadID.Value != input.ThreadID || state.ThreadRuntime.Value != value.worker.RuntimeID() || state.ThreadConversationID != input.ConversationID || slices.Contains(value.completedTurns, input.TurnID) {
		return ToolContext{}, ErrStaleOwner
	}
	if active := value.active; active != nil {
		if active.turnID != input.TurnID || active.threadID != input.ThreadID || active.conversationID != input.ConversationID || !active.startAcknowledged || active.finishing || active.stopRequested || active.unknown {
			return ToolContext{}, ErrBusy
		}
		if input.CapturedOwner != nil && (input.CapturedOwner.TurnID != active.turnID || input.CapturedOwner.ThreadID != active.threadID || input.CapturedOwner.ConversationID != active.conversationID) {
			return ToolContext{}, ErrStaleOwner
		}
		return value.ownerLocked(active), nil
	}
	if unconfirmedState(state) {
		return ToolContext{}, ErrUnknown
	}
	if input.CapturedOwner != nil && input.CapturedOwner.TurnID != "" {
		return ToolContext{}, ErrStaleOwner
	}
	for _, id := range input.MessageIDs {
		message, err := store.FindMessage(&state, id)
		if err != nil || message.Role != contracts.RoleUser {
			return ToolContext{}, ErrStaleOwner
		}
	}
	value.epoch++
	prepare, cancel := context.WithCancel(value.ctx)
	active := &execution{epoch: value.epoch, conversationID: input.ConversationID, callID: input.CallID, handoffID: input.HandoffID, threadID: input.ThreadID, turnID: input.TurnID, messageIDs: append([]string{}, input.MessageIDs...), startedAt: value.Timestamp(), updatedAt: value.Timestamp(), step: contracts.TaskProgressStageWorking, startSubmitted: true, startAcknowledged: true, nativeVoice: true, outputs: make(map[string]string), items: make(map[string]string), stopped: make(chan struct{}), prepare: prepare, cancelPreparation: cancel}
	if len(input.MessageIDs) > 0 {
		active.messageID = input.MessageIDs[0]
	}
	value.active = active
	value.confirmedStopped = false
	value.changeLocked()
	return value.ownerLocked(active), nil
}

func (value *Engine) HandleNativeEvent(ctx context.Context, owner ToolContext, event runtime.Event) error {
	value.mu.Lock()
	active := value.active
	valid := active != nil && value.currentLocked(active) && active.turnID == owner.TurnID && active.threadID == owner.ThreadID && active.conversationID == owner.ConversationID && (!active.nativeVoice || active.callID == owner.CallID)
	value.mu.Unlock()
	if !valid {
		return ErrStaleOwner
	}
	return value.handleEvent(ctx, event, false)
}

func (value *Engine) NativeTaskSnapshot(owner ToolContext) *contracts.ActiveExecution {
	snapshot := value.Snapshot()
	if snapshot.Active == nil || snapshot.Active.TurnID.Value != owner.TurnID || snapshot.Active.ThreadID.Value != owner.ThreadID || value.store.ConversationID() != owner.ConversationID {
		return nil
	}
	return snapshot.Active
}

func (value *Engine) ContinueNativeWork(owner ToolContext) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	active := value.active
	if active == nil || !value.currentLocked(active) {
		return ErrStaleOwner
	}
	if active.conversationID != owner.ConversationID || active.turnID != owner.TurnID || active.threadID != owner.ThreadID || active.callID != owner.CallID {
		return ErrStaleOwner
	}
	if active.stopRequested || active.finishing || active.unknown {
		return ErrStaleOwner
	}

	active.nativeBackground = true
	value.changeLocked()
	return nil
}

func (value *Engine) PauseNativeWork(ctx context.Context, owner ToolContext) error {
	value.mu.Lock()
	active := value.active
	if active == nil || !value.currentLocked(active) || active.turnID != owner.TurnID || active.threadID != owner.ThreadID || active.conversationID != owner.ConversationID {
		value.mu.Unlock()
		return ErrStaleOwner
	}
	active.pauseOnly = true
	active.stopRequested = true
	value.changeLocked()
	value.mu.Unlock()
	return value.interrupt(ctx, active)
}
