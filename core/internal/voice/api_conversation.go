package voice

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (api *API) nodeLocked(s *apiSession, id string) *conversationNode {
	if id == "" || contracts.UTF16Length(id) > 256 {
		return nil
	}
	if node := s.conversation[id]; node != nil {
		return node
	}
	if len(s.conversation) >= maxAPIConversationItems {
		s.conversationError = true
		return nil
	}
	node := &conversationNode{id: id, state: "pending"}
	s.conversation[id] = node
	s.conversationOrder = append(s.conversationOrder, id)
	return node
}

func (api *API) registerLocked(s *apiSession, item contracts.RawObject, previous json.RawMessage) {
	node := api.nodeLocked(s, textField(item, "id"))
	if node == nil {
		return
	}
	node.known = true
	if len(previous) > 0 {
		if string(previous) == "null" {
			node.previous = contracts.Null[string]()
		} else {
			var id string
			if json.Unmarshal(previous, &id) == nil {
				node.previous = contracts.Some(id)
			}
		}
	}
	node.role = textField(item, "role")
	node.inputAudio = false
	var content []contracts.RawObject
	_ = json.Unmarshal(item["content"], &content)
	if node.role == "user" {
		for _, part := range content {
			if textField(part, "type") == "input_audio" {
				node.inputAudio = true
			}
		}
	}
	if textField(item, "type") != "message" || node.role != "assistant" && !node.inputAudio {
		node.state = "skip"
	}
}

func (api *API) notifyConversation(s *apiSession) {
	select {
	case s.conversationNotify <- struct{}{}:
	default:
	}
}

func (api *API) flushConversationLocked(s *apiSession) {
	ordered := []*conversationNode{}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(*conversationNode) bool
	visit = func(node *conversationNode) bool {
		if visited[node.id] {
			return true
		}
		if !node.known || visiting[node.id] {
			return false
		}
		visiting[node.id] = true
		if id, ok := node.previous.Get(); ok && id != "" {
			prior := s.conversation[id]
			if prior == nil || !visit(prior) {
				delete(visiting, node.id)
				return false
			}
		}
		delete(visiting, node.id)
		visited[node.id] = true
		ordered = append(ordered, node)
		return true
	}
	for _, id := range s.conversationOrder {
		visit(s.conversation[id])
	}
	for _, node := range ordered {
		if node.emitted {
			continue
		}
		if node.state == "pending" {
			break
		}
		node.emitted = true
		if node.state != "final" || contracts.TrimText(node.text) == "" || node.role != "user" && node.role != "assistant" {
			continue
		}
		value := ConversationItem{s.callID, node.id, node.previous, contracts.Role(node.role), node.text}
		node.text = ""
		select {
		case s.conversationQueue <- value:
			s.conversationPending++
		default:
			s.conversationError = true
		}
	}
	api.notifyConversation(s)
}

func (api *API) conversationLoop(s *apiSession) {
	defer s.workers.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case value := <-s.conversationQueue:
			value.Text = api.redact(s, value.Text)
			var err error
			if api.options.OnConversationItem != nil {
				ctx, cancel := context.WithTimeout(s.ctx, api.options.RequestTimeout)
				err = api.options.OnConversationItem(ctx, value)
				cancel()
			}
			api.mu.Lock()
			s.conversationPending--
			if err != nil {
				s.conversationError = true
			}
			api.mu.Unlock()
			api.notifyConversation(s)
			if err != nil {
				api.notice("voice_context_save_unconfirmed")
			}
		}
	}
}

func (api *API) drainConversation(ctx context.Context, s *apiSession) error {
	for {
		api.mu.Lock()
		api.flushConversationLocked(s)
		pending := s.conversationPending > 0
		for _, node := range s.conversation {
			if node.known && (node.inputAudio && node.state == "pending" || node.state == "final" && !node.emitted) {
				pending = true
			}
		}
		failed := s.conversationError
		api.mu.Unlock()
		if failed {
			return ErrVoiceContext
		}
		if !pending {
			return nil
		}
		select {
		case <-ctx.Done():
			return ErrVoiceContext
		case <-s.ctx.Done():
			return ErrVoiceContext
		case <-s.conversationNotify:
		}
	}
}

func (api *API) ConversationReady(ctx context.Context, callID string) error {
	api.mu.Lock()
	s := api.session
	current := s != nil && s.callID == callID
	api.mu.Unlock()
	if !current || !api.current(s) {
		return ErrVoiceCancelled
	}
	bounded, cancel := context.WithTimeout(ctx, api.options.RequestTimeout)
	defer cancel()
	if err := api.drainConversation(bounded, s); err != nil {
		return err
	}
	if !api.current(s) {
		return ErrVoiceCancelled
	}
	return nil
}
