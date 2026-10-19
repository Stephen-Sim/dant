package voice

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func (native *Native) CanContinueWhileIdle(owner work.ContinuationOwner) bool {
	snapshot := native.options.Engine.Snapshot()
	state := native.options.Store.Snapshot()
	worker := native.options.Worker.Snapshot()
	native.mu.Lock()
	defer native.mu.Unlock()
	s := native.session
	if s == nil {
		return true
	}
	thread, _ := state.ThreadID.Get()
	if s.status != contracts.VoiceCallStatusConnected || s.connectedAt == 0 || !s.started || !s.startAccepted || s.threadID == "" || s.threadID != thread || s.threadID != owner.ThreadID || state.ConversationID != owner.ConversationID || s.closed || s.background || s.stopping || s.pausing || s.reconnecting || s.unknown || s.queuedEvents > 0 || pendingHandoffs(s) || worker.Status != contracts.ConnectionStatusOnline || snapshot.Takeover || snapshot.Acquiring {
		return false
	}
	if snapshot.Active != nil && snapshot.Active.WorkID != owner.WorkID {
		return false
	}
	for _, turn := range s.turns {
		if !turn.done {
			return false
		}
	}
	for _, input := range s.callInputs {
		if !input.settled {
			return false
		}
	}
	if s.continuation != nil && (!reflect.DeepEqual(s.continuation.admission.Owner, owner) || s.continuation.conflict) {
		return false
	}
	if s.contextQueue != nil {
		queue := s.contextQueue
		queue.mu.Lock()
		busy := queue.closed || queue.uncertain || len(queue.pending) > 0 || queue.activeCancel != nil
		queue.mu.Unlock()
		if busy {
			return false
		}
	}
	return true
}

func (native *Native) BeginContinuationAdmission(owner work.ContinuationOwner) (work.ContinuationAdmission, error) {
	if !native.CanContinueWhileIdle(owner) {
		return work.ContinuationAdmission{}, ErrNativeUnknown
	}
	native.mu.Lock()
	defer native.mu.Unlock()
	s := native.session
	if s == nil {
		return work.ContinuationAdmission{Owner: owner}, nil
	}
	if s.continuation != nil {
		return work.ContinuationAdmission{}, ErrNativeUnknown
	}
	admission := work.ContinuationAdmission{Owner: owner, CallID: s.mediaID, Generation: s.generation, WorkEpoch: s.workEpoch}
	s.continuation = &nativeContinuation{admission: admission}
	return admission, nil
}

func (native *Native) continuationCurrentLocked(admission work.ContinuationAdmission) bool {
	s := native.session
	return s != nil && s.continuation != nil && reflect.DeepEqual(s.continuation.admission, admission) && s.mediaID == admission.CallID && s.generation == admission.Generation && s.workEpoch == admission.WorkEpoch && s.threadID == admission.Owner.ThreadID
}

func (native *Native) ReplayContinuationEvents(ctx context.Context, admission work.ContinuationAdmission, events []runtime.Event, acknowledgedTurnID string, notSubmitted bool) ([]runtime.Event, bool, error) {
	if len(events) > nativeEventLimit {
		return nil, true, ErrNativeUnknown
	}
	size := 0
	projected := make([]runtime.Event, 0, len(events))
	for _, event := range events {
		event = runtime.PrepareObserverEvent(event)
		raw, err := json.Marshal(event)
		if err != nil {
			return nil, true, ErrNativeUnknown
		}
		size += len(raw)
		if size > nativeEventByteLimit {
			return nil, true, ErrNativeUnknown
		}
		projected = append(projected, event)
	}
	native.mu.Lock()
	s := native.session
	if s == nil {
		native.mu.Unlock()
		return projected, false, nil
	}
	current := native.continuationCurrentLocked(admission)
	owned, foreign := []runtime.Event{}, []runtime.Event{}
	for _, event := range projected {
		if textField(event.Params, "threadId") != admission.Owner.ThreadID {
			continue
		}
		if acknowledgedTurnID != "" && turnID(event) == acknowledgedTurnID {
			owned = append(owned, event)
		} else {
			foreign = append(foreign, event)
		}
	}
	conflict := !current || acknowledgedTurnID == "" && !notSubmitted
	if current {
		entry := s.continuation
		entry.retained = projected
		entry.turnID = acknowledgedTurnID
		if acknowledgedTurnID != "" && (entry.conflict || len(foreign) > 0 || s.turns[acknowledgedTurnID] != nil || s.finished[acknowledgedTurnID]) {
			conflict = true
		}
		if conflict {
			s.unknown = true
			entry.conflict = true
		} else if acknowledgedTurnID != "" {
			entry.checked = true
		}
	}
	native.mu.Unlock()
	if conflict {
		native.changed()
		if !current {
			return nil, true, nil
		}
		return owned, true, nil
	}
	for _, event := range foreign {
		if err := native.HandleEvent(ctx, event); err != nil {
			return owned, true, err
		}
	}
	return owned, false, nil
}

func (native *Native) ConfirmContinuationAdmission(admission work.ContinuationAdmission, acknowledgedTurnID string) error {
	state := native.options.Store.Snapshot()
	native.mu.Lock()
	defer native.mu.Unlock()
	if native.session == nil && admission.CallID == "" {
		return nil
	}
	if !native.continuationCurrentLocked(admission) {
		return ErrNativeUnknown
	}
	s := native.session
	entry := s.continuation
	if !entry.checked || entry.conflict || entry.turnID != acknowledgedTurnID || acknowledgedTurnID == "" || s.status != contracts.VoiceCallStatusConnected || s.closed || s.stopping || s.unknown || s.queuedEvents > 0 || pendingHandoffs(s) || state.ConversationID != admission.Owner.ConversationID {
		s.unknown = true
		return ErrNativeUnknown
	}
	entry.acknowledged = true
	return nil
}

func (native *Native) FinishContinuationAdmission(admission work.ContinuationAdmission) {
	native.mu.Lock()
	defer native.mu.Unlock()
	if native.continuationCurrentLocked(admission) {
		native.session.continuation = nil
	}
}
