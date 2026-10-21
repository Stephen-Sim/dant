package voice

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func turnID(event runtime.Event) string {
	if id := textField(event.Params, "turnId"); id != "" {
		return id
	}
	return textField(objectField(event.Params, "turn"), "id")
}

func (native *Native) OwnsEvent(event runtime.Event) bool {
	native.mu.Lock()
	s := native.session
	if s == nil || s.threadID == "" || textField(event.Params, "threadId") != s.threadID {
		native.mu.Unlock()
		return false
	}
	id := turnID(event)
	_, tracked := s.turns[id]
	native.mu.Unlock()
	if strings.HasPrefix(event.Method, "thread/realtime/") {
		return true
	}
	if !strings.HasPrefix(event.Method, "turn/") && !strings.HasPrefix(event.Method, "item/") {
		return false
	}
	if tracked {
		return true
	}
	snapshot := native.options.Engine.Snapshot()
	if snapshot.Active != nil {
		activeID, _ := snapshot.Active.TurnID.Get()
		if activeID == id || activeID == "" {
			return false
		}
	}
	return true
}

func (native *Native) HandleEvent(ctx context.Context, event runtime.Event) error {
	if !native.OwnsEvent(event) {
		return nil
	}
	// The runtime projection drops observer-only image bytes while retaining the
	// exact task/tool ownership metadata before applying this queue budget.
	event = runtime.PrepareObserverEvent(event)
	data, err := json.Marshal(event)
	if err != nil {
		return ErrNativeUnknown
	}
	native.mu.Lock()
	s := native.session
	if s == nil || textField(event.Params, "threadId") != s.threadID {
		native.mu.Unlock()
		return nil
	}
	if s.continuation != nil && !s.continuation.acknowledged && event.Method == "thread/realtime/itemAdded" && textField(objectField(event.Params, "item"), "type") == "handoff_request" {
		s.continuation.conflict = true
	}
	if s.queuedEvents >= nativeEventLimit || s.queuedBytes+len(data) > nativeEventByteLimit {
		s.unknown = true
		native.mu.Unlock()
		native.changed()
		return ErrNativeUnknown
	}
	queued := nativeQueuedEvent{event, s.generation, len(data)}
	target := s.workEvents
	switch event.Method {
	case "thread/realtime/started", "thread/realtime/sdp", "thread/realtime/closed", "thread/realtime/error":
		target = s.mediaEvents
	}
	select {
	case target <- queued:
		s.queuedEvents++
		s.queuedBytes += len(data)
		native.mu.Unlock()
		return nil
	default:
		s.unknown = true
		native.mu.Unlock()
		native.changed()
		return ErrNativeUnknown
	}
}

func (native *Native) eventLoop(s *nativeSession, media bool) {
	defer s.workers.Done()
	queue := s.workEvents
	if media {
		queue = s.mediaEvents
	}
	for {
		select {
		case <-s.ctx.Done():
			return
		case queued := <-queue:
			err := native.processEvent(s, queued)
			native.mu.Lock()
			s.queuedEvents--
			s.queuedBytes -= queued.bytes
			if err != nil {
				s.unknown = true
				code := ErrNativeUnknown.Error()
				native.lastError = &code
			}
			native.mu.Unlock()
			if err != nil {
				native.changed()
			}
		}
	}
}

func (native *Native) processEvent(s *nativeSession, queued nativeQueuedEvent) error {
	event := queued.event
	native.mu.Lock()
	if native.session != s {
		native.mu.Unlock()
		return nil
	}
	if strings.HasPrefix(event.Method, "thread/realtime/") {
		if s.generation != queued.generation {
			native.mu.Unlock()
			return nil
		}
		p := event.Params
		item := objectField(p, "item")
		realtime := textField(p, "realtimeSessionId")
		if realtime == "" {
			realtime = textField(item, "realtime_session_id")
		}
		if realtime == "" {
			realtime = textField(item, "realtimeSessionId")
		}
		if realtime != "" && (s.retired.has(realtime) || s.realtimeID != "" && realtime != s.realtimeID) || textField(p, "callId") != "" && textField(p, "callId") != s.mediaID {
			native.mu.Unlock()
			return nil
		}
		var caption *Caption
		subtitles := s.subtitles
		allowCaption := !s.stopping && !s.closed && !s.background && (s.status == contracts.VoiceCallStatusNegotiating || s.status == contracts.VoiceCallStatusConnected)
		switch event.Method {
		case "thread/realtime/started":
			if textField(p, "version") != "v3" {
				select {
				case s.failure <- ErrVoiceConnection:
				default:
				}
				native.mu.Unlock()
				return nil
			}
			s.started = true
			s.realtimeID = textField(p, "realtimeSessionId")
		case "thread/realtime/sdp":
			answer := textField(p, "sdp")
			if !validSDP(answer) {
				select {
				case s.failure <- ErrVoiceConnection:
				default:
				}
				native.mu.Unlock()
				return nil
			}
			s.answer = answer
		case "thread/realtime/closed":
			s.closed = true
			s.closedOnce.Do(func() { close(s.closedSignal) })
			select {
			case s.failure <- ErrVoiceConnection:
			default:
			}
		case "thread/realtime/error":
			s.unknown = true
			code := ErrVoiceConnection.Error()
			native.lastError = &code
			select {
			case s.failure <- ErrVoiceConnection:
			default:
			}
		}
		if s.started && s.answer != "" {
			s.readyOnce.Do(func() { close(s.ready) })
		}
		closed := event.Method == "thread/realtime/closed"
		autoStop := closed && !s.stopping && !s.background
		callID := s.mediaID
		if autoStop {
			s.workers.Add(1)
		}
		handoff := event.Method == "thread/realtime/itemAdded" && textField(item, "type") == "handoff_request"
		native.mu.Unlock()
		if allowCaption && subtitles != nil {
			caption = subtitles.Native(event.Method, p)
		}
		if closed && subtitles != nil {
			caption = subtitles.Clear()
		}
		if caption != nil && native.options.Subtitle != nil {
			native.options.Subtitle(*caption)
		}
		if handoff {
			return native.observeHandoff(s, item)
		}
		if autoStop {
			go func() {
				defer s.workers.Done()
				ctx, cancel := context.WithTimeout(s.ctx, native.options.StopTimeout)
				defer cancel()
				_ = native.Stop(ctx, callID)
			}()
		}
		native.changed()
		return nil
	}
	id := turnID(event)
	turn := s.turns[id]
	if id == "" || s.finished[id] {
		native.mu.Unlock()
		return nil
	}
	if turn != nil {
		owner := turn.owner
		native.mu.Unlock()
		err := native.options.Engine.HandleNativeEvent(s.ctx, owner, event)
		if event.Method == "turn/completed" {
			native.mu.Lock()
			turn.done = true
			s.finished[id] = true
			native.mu.Unlock()
			native.changed()
		}
		return err
	}
	if len(s.pendingTurns) >= nativeTurnLimit || s.pendingBytes+queued.bytes > nativeEventByteLimit {
		native.mu.Unlock()
		return ErrNativeUnknown
	}
	if _, ok := s.pendingTurns[id]; !ok {
		s.pendingOrder = append(s.pendingOrder, id)
	}
	s.pendingTurns[id] = append(s.pendingTurns[id], event)
	s.pendingBytes += queued.bytes
	native.mu.Unlock()
	return native.tryAdopt(s)
}

func (native *Native) observeHandoff(s *nativeSession, item contracts.RawObject) error {
	id, itemID := textField(item, "handoff_id"), textField(item, "item_id")
	var transcript string
	var active []contracts.RawObject
	if !captionID(id) || !captionID(itemID) || json.Unmarshal(item["input_transcript"], &transcript) != nil || string(item["input_transcript"]) == "null" || json.Unmarshal(item["active_transcript"], &active) != nil || active == nil {
		return ErrNativeUnknown
	}
	for _, entry := range active {
		for _, key := range []string{"role", "text"} {
			var value string
			if string(entry[key]) == "null" || json.Unmarshal(entry[key], &value) != nil {
				return ErrNativeUnknown
			}
		}
	}
	if transcript == "" && len(active) == 0 {
		return nil
	}
	native.mu.Lock()
	if native.session != s {
		native.mu.Unlock()
		return nil
	}
	if existing := s.handoffs[id]; existing != nil {
		native.mu.Unlock()
		if existing.itemID != itemID {
			return ErrNativeUnknown
		}
		return nil
	}
	if len(s.handoffs) >= nativeTurnLimit {
		native.mu.Unlock()
		return ErrNativeUnknown
	}
	s.handoffs[id] = &nativeHandoff{itemID: itemID}
	s.handoffOrder = append(s.handoffOrder, id)
	native.mu.Unlock()
	return native.tryAdopt(s)
}

func (native *Native) tryAdopt(s *nativeSession) error {
	snapshot := native.options.Engine.Snapshot()
	state := native.options.Store.Snapshot()
	native.mu.Lock()
	if native.session != s || s.unknown {
		native.mu.Unlock()
		return ErrNativeUnknown
	}
	handoffID := ""
	for _, id := range s.handoffOrder {
		value := s.handoffs[id]
		if value.turnID == "" && !value.idleConfirmed {
			handoffID = id
			break
		}
	}
	if handoffID == "" {
		native.mu.Unlock()
		return nil
	}
	id := ""
	var captured *work.ToolContext
	if snapshot.Active != nil {
		turn, _ := snapshot.Active.TurnID.Get()
		thread, _ := snapshot.Active.ThreadID.Get()
		if turn != "" && thread == s.threadID {
			id = turn
			captured = &work.ToolContext{ConversationID: state.ConversationID, WorkID: snapshot.Active.WorkID, TurnID: turn, ThreadID: thread}
		}
	}
	if id == "" {
		if len(s.pendingOrder) == 0 {
			native.mu.Unlock()
			return nil
		}
		if len(s.pendingOrder) != 1 {
			native.mu.Unlock()
			return ErrNativeUnknown
		}
		id = s.pendingOrder[0]
		acknowledged := false
		for _, event := range s.pendingTurns[id] {
			if event.Method == "turn/started" {
				acknowledged = true
			}
		}
		if !acknowledged {
			native.mu.Unlock()
			return nil
		}
	}
	for _, pendingID := range s.pendingOrder {
		if pendingID != id {
			native.mu.Unlock()
			return ErrNativeUnknown
		}
	}
	thread, callID := s.threadID, s.mediaID
	events := append([]runtime.Event{}, s.pendingTurns[id]...)
	native.mu.Unlock()
	owner, err := native.options.Engine.AdoptNativeTurn(s.ctx, work.NativeTurnInput{ConversationID: state.ConversationID, CallID: callID, ThreadID: thread, TurnID: id, HandoffID: handoffID, CapturedOwner: captured})
	if err != nil {
		return err
	}
	native.mu.Lock()
	if native.session != s || s.threadID != thread {
		native.mu.Unlock()
		return ErrNativeUnknown
	}
	s.handoffs[handoffID].turnID = id
	s.turns[id] = &nativeTurn{owner: owner}
	delete(s.pendingTurns, id)
	s.pendingOrder = nil
	s.pendingBytes = 0
	native.mu.Unlock()
	for _, event := range events {
		if err = native.options.Engine.HandleNativeEvent(s.ctx, owner, event); err != nil {
			return err
		}
		if event.Method == "turn/completed" {
			native.mu.Lock()
			s.turns[id].done = true
			s.finished[id] = true
			native.mu.Unlock()
		}
	}
	native.changed()
	return nil
}
