package voice

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (api *API) queue(s *apiSession) (*ContextQueue, error) {
	api.mu.Lock()
	defer api.mu.Unlock()
	if s.contextQueue != nil {
		return s.contextQueue, nil
	}
	queue, err := NewContextQueue(s.ctx, ContextQueueOptions{CallID: s.callID, Timeout: api.options.ContextTimeout, IsCurrent: func() bool { return api.current(s) }, Send: func(ctx context.Context, input ContextInput) error { return api.sendContext(ctx, s, input) }})
	if err != nil {
		return nil, err
	}
	s.contextQueue = queue
	return queue, nil
}

func (api *API) SyncMemory(ctx context.Context, callID, memory string) ContextResult {
	api.mu.Lock()
	s := api.session
	valid := s != nil && s.callID == callID && s.ready && !s.closed
	api.mu.Unlock()
	if !valid {
		return ContextResult{CallID: callID, Kind: "memory", Status: contracts.LiveContextStatusCancelled}
	}
	queue, err := api.queue(s)
	if err != nil {
		return ContextResult{CallID: callID, Kind: "memory", Status: contracts.LiveContextStatusFailed}
	}
	return queue.Enqueue(ctx, ContextInput{Key: "memory", Text: string(rawValue(memory)), Kind: "memory"})
}

func (api *API) SyncContext(ctx context.Context, callID, kind string, message *contracts.ChatMessage) ContextResult {
	messageID := ""
	if message != nil {
		messageID = message.ID
	}
	api.mu.Lock()
	s := api.session
	valid := s != nil && s.callID == callID && s.ready && !s.closed
	api.mu.Unlock()
	if !valid {
		return ContextResult{CallID: callID, ContextID: api.options.NewID(), MessageID: messageID, Kind: kind, Status: contracts.LiveContextStatusCancelled}
	}
	text, err := BuildCallContext(kind, message, nil)
	if err != nil {
		return ContextResult{CallID: callID, MessageID: messageID, Kind: kind, Status: contracts.LiveContextStatusFailed, Error: "The live call reference is invalid."}
	}
	queue, err := api.queue(s)
	if err != nil {
		return ContextResult{CallID: callID, MessageID: messageID, Kind: kind, Status: contracts.LiveContextStatusFailed}
	}
	return queue.Enqueue(ctx, ContextInput{Key: kind + ":" + messageID, Text: text, MessageID: messageID, Kind: kind})
}

func (api *API) sendContext(ctx context.Context, s *apiSession, input ContextInput) error {
	if !api.current(s) {
		return ErrVoiceCancelled
	}
	reference := ""
	var err error
	if api.options.Context != nil {
		reference, err = api.options.Context(ctx, true)
		if err != nil {
			return ErrContextRejected
		}
	}
	api.mu.Lock()
	if api.session != s || s.socket == nil || s.closed || s.stopping {
		api.mu.Unlock()
		return ErrContextRejected
	}
	entries := map[string]string{}
	for key, value := range s.contextEntries {
		entries[key] = value
	}
	order := append([]string{}, s.contextOrder...)
	memory := s.baseMemory
	if input.Kind == "memory" {
		if json.Unmarshal([]byte(input.Text), &memory) != nil {
			api.mu.Unlock()
			return ErrContextRejected
		}
	} else {
		filtered := order[:0]
		for _, key := range order {
			if key != input.Key {
				filtered = append(filtered, key)
			}
		}
		order = append(filtered, input.Key)
		entries[input.Key] = input.Text
	}
	base := api.baseInstructions(s, memory)
	parts := []string{}
	for _, key := range order {
		parts = append(parts, entries[key])
	}
	instructions := base + "\n\n" + strings.Join(parts, "\n\n") + "\n\nCurrent chat reference and reactions:\n" + reference + "\n\n<dant_live_context_id>" + input.ContextID + "</dant_live_context_id>"
	ack := &apiContextAck{id: input.ContextID, instructions: instructions, entries: entries, order: order, memory: memory, base: base, done: make(chan error, 1), sent: true}
	s.contextAck = ack
	api.mu.Unlock()
	if err = api.write(ctx, s, object(map[string]any{"type": "session.update", "event_id": input.ContextID, "session": map[string]any{"type": "realtime", "instructions": instructions}})); err == nil {
		select {
		case err = <-ack.done:
		case <-ctx.Done():
			err = ErrContextUnknown
		case <-s.ctx.Done():
			err = ErrVoiceCancelled
		}
	}
	api.mu.Lock()
	if s.contextAck == ack {
		s.contextAck = nil
	}
	api.mu.Unlock()
	return err
}
