package work

import (
	"context"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type CallStartReservation struct {
	CallID, Provider, ConversationID, ActiveWorkID, ActiveTurnID string
	EngineEpoch                                                  uint64
	Token                                                        string
}

func (value *Engine) ReserveCallStart(ctx context.Context, callID, provider string) (CallStartReservation, error) {
	if err := ctx.Err(); err != nil {
		return CallStartReservation{}, err
	}
	if callID == "" || (provider != "subscription" && provider != "api") {
		return CallStartReservation{}, ErrStaleOwner
	}
	if value.options.Calls != nil && value.options.Calls.Snapshot() != nil {
		return CallStartReservation{}, ErrBusy
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance || value.takeover || value.acquiring || value.callReservation != nil {
		return CallStartReservation{}, ErrBusy
	}
	state := value.store.Snapshot()
	if _, present := state.Extra[executorStopFenceKey]; present {
		return CallStartReservation{}, ErrUnknown
	}
	reservation := CallStartReservation{CallID: callID, Provider: provider, ConversationID: state.ConversationID, EngineEpoch: value.epoch, Token: value.options.NewID()}
	if value.active != nil {
		reservation.ActiveTurnID = value.active.turnID
		reservation.ActiveWorkID = value.active.workID
	}
	value.callReservation = &reservation
	value.changeLocked()
	return reservation, nil
}

func (value *Engine) CallStartCurrent(reservation CallStartReservation) bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.takeover || value.acquiring || value.callReservation == nil || value.callReservation.Token != reservation.Token || value.callReservation.CallID != reservation.CallID || value.callReservation.ConversationID != reservation.ConversationID || value.store.ConversationID() != reservation.ConversationID {
		return false
	}
	if reservation.Provider == "subscription" && value.epoch != reservation.EngineEpoch {
		return false
	}
	return true
}

func (value *Engine) ReleaseCallStart(reservation CallStartReservation) {
	value.mu.Lock()
	if value.callReservation != nil && value.callReservation.Token == reservation.Token && value.callReservation.CallID == reservation.CallID {
		value.callReservation = nil
		value.changeLocked()
	}
	value.mu.Unlock()
	value.Wake()
}

func (value *Engine) CallSnapshot() *contracts.Call {
	if value.options.Calls == nil {
		return nil
	}
	return value.options.Calls.Snapshot()
}
