package voice

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func (native *Native) PendingWork() bool {
	native.mu.Lock()
	defer native.mu.Unlock()
	s := native.session
	if s == nil {
		return false
	}
	if s.unknown || s.pausing || pendingHandoffs(s) || s.reconnecting {
		return true
	}
	for _, entry := range s.callInputs {
		if !entry.settled {
			return true
		}
	}
	for _, turn := range s.turns {
		if !turn.done {
			return true
		}
	}
	return false
}

func (native *Native) PauseWork(ctx context.Context) error {
	native.mu.Lock()
	s := native.session
	if s == nil {
		native.mu.Unlock()
		return nil
	}
	s.pausing = true
	s.workEpoch++
	owners := []work.ToolContext{}
	for _, turn := range s.turns {
		if !turn.done {
			owners = append(owners, turn.owner)
		}
	}
	native.mu.Unlock()
	native.changed()
	for _, owner := range owners {
		if err := native.options.Engine.PauseNativeWork(ctx, owner); err != nil {
			native.mu.Lock()
			s.unknown = true
			native.mu.Unlock()
			native.changed()
			return err
		}
	}
	native.mu.Lock()
	if native.session == s {
		s.pausing = false
	}
	native.mu.Unlock()
	native.changed()
	return nil
}

func (native *Native) Stop(ctx context.Context, callID string) error {
	return native.stop(ctx, callID, CallEndUser)
}

func (native *Native) stop(ctx context.Context, callID string, reason CallEndReason) error {
	native.mu.Lock()
	s := native.session
	if s == nil {
		native.mu.Unlock()
		return nil
	}
	if s.mediaID != callID {
		native.mu.Unlock()
		return ErrVoiceCancelled
	}
	native.mu.Unlock()
	s.stopMu.Lock()
	defer s.stopMu.Unlock()
	native.mu.Lock()
	if native.session != s {
		native.mu.Unlock()
		return nil
	}
	if s.background && s.closed {
		native.mu.Unlock()
		return nil
	}
	if s.unknown {
		native.mu.Unlock()
		return ErrNativeStop
	}
	s.stopping = true
	s.status = contracts.VoiceCallStatusStopping
	generation := s.generation
	connectedAt := float64(s.connectedAt)
	thread := s.threadID
	closed := s.closed
	queue := s.contextQueue
	s.contextQueue = nil
	native.mu.Unlock()
	native.changed()
	if s.subtitles != nil {
		if value := s.subtitles.Clear(); value != nil && native.options.Subtitle != nil {
			native.options.Subtitle(*value)
		}
	}
	bounded, cancel := context.WithTimeout(ctx, native.options.StopTimeout)
	defer cancel()
	if queue != nil {
		if err := queue.Close(bounded); err != nil {
			return native.stopUnknown(s)
		}
	}
	if !closed && thread != "" {
		if _, err := native.options.Worker.Request(bounded, "thread/realtime/stop", object(map[string]any{"threadId": thread})); err != nil {
			return native.stopUnknown(s)
		}
		native.mu.Lock()
		signal := s.closedSignal
		native.mu.Unlock()
		select {
		case <-signal:
		case <-bounded.Done():
			return native.stopUnknown(s)
		}
	}
	if thread == "" {
		native.finish(s)
		return nil
	}
	response, err := native.options.Worker.Request(bounded, "thread/read", object(map[string]any{"threadId": thread, "includeTurns": true}))
	if err != nil {
		return native.stopUnknown(s)
	}
	observed := objectField(response, "thread")
	var turns []contracts.RawObject
	if textField(observed, "id") != thread || json.Unmarshal(observed["turns"], &turns) != nil || turns == nil || len(turns) > 10000 {
		return native.stopUnknown(s)
	}
	statuses := map[string]string{}
	for _, turn := range turns {
		id, status := textField(turn, "id"), textField(turn, "status")
		if !captionID(id) || statuses[id] != "" || status != "inProgress" && status != "completed" && status != "interrupted" && status != "failed" {
			return native.stopUnknown(s)
		}
		statuses[id] = status
	}
	native.mu.Lock()
	if native.session != s || s.generation != generation {
		native.mu.Unlock()
		return ErrNativeStop
	}
	owners := []work.ToolContext{}
	missing := len(s.pendingOrder) > 0
	for id, turn := range s.turns {
		if statuses[id] == "" {
			missing = true
		}
		if !turn.done {
			owners = append(owners, turn.owner)
		}
	}
	for id, status := range statuses {
		if status == "inProgress" {
			if _, known := s.turns[id]; !known {
				missing = true
			}
		}
	}
	if pendingHandoffs(s) {
		if textField(objectField(observed, "status"), "type") != "idle" {
			missing = true
		}
		for _, status := range statuses {
			if status == "inProgress" {
				missing = true
			}
		}
		if !missing {
			for _, handoff := range s.handoffs {
				if handoff.turnID == "" {
					handoff.idleConfirmed = true
				}
			}
		}
	}
	if missing {
		native.mu.Unlock()
		return native.stopUnknown(s)
	}
	s.background = true
	s.closed = true
	s.stopping = false
	s.status = contracts.VoiceCallStatusBackground
	native.mu.Unlock()
	for _, owner := range owners {
		if statuses[owner.TurnID] == "inProgress" {
			if reason == CallEndShutdown {
				err = native.options.Engine.PauseNativeWork(bounded, owner)
			} else {
				err = native.options.Engine.ContinueNativeWork(owner)
			}
			if err != nil {
				return native.stopUnknown(s)
			}
		} else {
			event := runtime.Event{Method: "turn/completed", Params: object(map[string]any{"threadId": thread, "turnId": owner.TurnID, "turn": map[string]any{"id": owner.TurnID, "status": statuses[owner.TurnID]}})}
			if err = native.options.Engine.HandleNativeEvent(bounded, owner, event); err != nil {
				return native.stopUnknown(s)
			}
			native.mu.Lock()
			s.turns[owner.TurnID].done = true
			s.finished[owner.TurnID] = true
			native.mu.Unlock()
		}
	}
	native.mu.Lock()
	ended := native.ended
	native.mu.Unlock()
	if ended != nil {
		if err := ended(bounded, EndedEvent{CallID: callID, Provider: "subscription", Reason: reason, ConnectedAt: connectedAt}); err != nil {
			return err
		}
	}
	native.changed()
	if len(owners) == 0 {
		native.finish(s)
	}
	return nil
}

func (native *Native) stopUnknown(s *nativeSession) error {
	native.mu.Lock()
	if native.session == s {
		s.unknown = true
		s.status = contracts.VoiceCallStatusStopUnconfirmed
		s.stopping = false
		code := ErrNativeStop.Error()
		native.lastError = &code
	}
	native.mu.Unlock()
	native.changed()
	return ErrNativeStop
}

func (native *Native) finish(s *nativeSession) {
	native.mu.Lock()
	if native.session == s {
		native.session = nil
	}
	s.cancel()
	native.mu.Unlock()
	native.changed()
}

func (native *Native) Close(ctx context.Context) error {
	native.mu.Lock()
	native.disposed = true
	s := native.session
	owned := make([]*nativeSession, 0, len(native.sessions))
	for session := range native.sessions {
		owned = append(owned, session)
	}
	native.mu.Unlock()
	var err error
	if s != nil {
		err = native.stop(ctx, s.mediaID, CallEndShutdown)
		if err == nil {
			native.mu.Lock()
			pending := false
			for _, turn := range s.turns {
				pending = pending || !turn.done
			}
			native.mu.Unlock()
			if pending {
				err = native.PauseWork(ctx)
			}
			if err == nil {
				native.finish(s)
			}
		}
	}
	for _, session := range owned {
		session.cancel()
		native.mu.Lock()
		queue := session.contextQueue
		native.mu.Unlock()
		if queue != nil {
			if queueErr := queue.Close(ctx); queueErr != nil && err == nil {
				err = queueErr
			}
		}
	}
	for _, session := range owned {
		select {
		case <-session.joined:
		case <-ctx.Done():
			return ErrNativeStop
		}
	}
	return err
}
