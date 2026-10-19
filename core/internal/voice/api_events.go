package voice

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func (api *API) readLoop(s *apiSession) {
	defer s.workers.Done()
	for {
		data, err := s.socket.Read(s.ctx)
		if err != nil {
			api.fail(s, ErrVoiceConnection)
			return
		}
		event, err := contracts.DecodeObject(data, maxVoiceEventBytes)
		if err != nil {
			continue
		}
		api.handle(s, event)
	}
}

func (api *API) write(ctx context.Context, s *apiSession, event contracts.RawObject) error {
	api.mu.Lock()
	socket := s.socket
	current := api.session == s && !s.closed && !s.stopping
	api.mu.Unlock()
	if socket == nil || !current {
		return ErrVoiceConnection
	}
	if err := socket.Write(ctx, rawValue(event)); err != nil {
		return ErrVoiceConnection
	}
	return nil
}

func (api *API) respond(s *apiSession) {
	api.mu.Lock()
	ready := api.session == s && s.needsResponse && s.pendingTools == 0 && !s.activeResponse && !s.closed && !s.stopping && s.ctx.Err() == nil
	if ready {
		s.needsResponse = false
		s.activeResponse = true
	}
	api.mu.Unlock()
	if !ready {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, api.options.RequestTimeout)
	defer cancel()
	if err := api.write(ctx, s, object(map[string]any{"type": "response.create"})); err != nil {
		api.fail(s, ErrVoiceConnection)
	}
}

func (api *API) handle(s *apiSession, event contracts.RawObject) {
	kind := textField(event, "type")
	if kind == "" {
		return
	}
	api.mu.Lock()
	current := api.session == s && !s.closed
	stopping := s.stopping
	api.mu.Unlock()
	if !current {
		return
	}
	if !stopping {
		if value := s.subtitles.API(event); value != nil && api.options.Subtitle != nil {
			api.options.Subtitle(*value)
		}
	}
	var fatal error
	var usage contracts.RawObject
	api.mu.Lock()
	if api.session != s || s.closed {
		api.mu.Unlock()
		return
	}
	item := objectField(event, "item")
	response := objectField(event, "response")
	eventError := objectField(event, "error")
	if (kind == "conversation.item.added" || kind == "conversation.item.done") && s.inputAck != nil {
		entry := s.inputAck
		var content []contracts.RawObject
		_ = json.Unmarshal(item["content"], &content)
		if textField(item, "id") == entry.itemID && textField(item, "type") == "message" && textField(item, "role") == "user" && len(content) == 1 && textField(content[0], "type") == "input_text" && textField(content[0], "text") == entry.inputText {
			entry.submission = contracts.SubmissionStatusConfirmed
			at := api.options.Now().UnixMilli()
			entry.confirmedAt = &at
			s.inputAck = nil
			select {
			case entry.ack <- nil:
			default:
			}
		}
	}
	if kind == "error" && s.inputAck != nil && textField(eventError, "event_id") == s.inputAck.eventID {
		entry := s.inputAck
		entry.submission = contracts.SubmissionStatusRejected
		s.inputAck = nil
		select {
		case entry.ack <- ErrContextRejected:
		default:
		}
	}
	if kind == "session.updated" && s.contextAck != nil && textField(objectField(event, "session"), "instructions") == s.contextAck.instructions {
		ack := s.contextAck
		s.contextAck = nil
		s.contextEntries = ack.entries
		s.contextOrder = ack.order
		s.baseMemory = ack.memory
		s.baseInstructions = ack.base
		select {
		case ack.done <- nil:
		default:
		}
	}
	if kind == "error" && s.contextAck != nil && textField(eventError, "event_id") == s.contextAck.id {
		ack := s.contextAck
		s.contextAck = nil
		select {
		case ack.done <- ErrContextRejected:
		default:
		}
	}
	switch kind {
	case "conversation.item.added", "conversation.item.done":
		api.registerLocked(s, item, event["previous_item_id"])
	case "input_audio_buffer.committed":
		api.registerLocked(s, object(map[string]any{"id": textField(event, "item_id"), "type": "message", "role": "user", "content": []map[string]any{{"type": "input_audio"}}}), event["previous_item_id"])
	case "conversation.item.input_audio_transcription.completed":
		if node := api.nodeLocked(s, textField(event, "item_id")); node != nil && !node.emitted {
			var transcript string
			if raw, ok := event["transcript"]; ok && string(raw) != "null" && json.Unmarshal(raw, &transcript) == nil {
				node.state = "final"
				node.text = transcript
			}
		}
	case "conversation.item.input_audio_transcription.failed", "conversation.item.deleted", "conversation.item.truncated":
		if node := api.nodeLocked(s, textField(event, "item_id")); node != nil && !node.emitted {
			node.state = "skip"
			node.text = ""
		}
	case "response.created":
		s.activeResponse = true
	case "response.done":
		s.activeResponse = false
		usage = object(map[string]any{"callId": s.callID, "responseId": textField(response, "id")})
		if raw, ok := response["usage"]; ok {
			usage["usage"] = raw
		}
		var output []contracts.RawObject
		_ = json.Unmarshal(response["output"], &output)
		for _, item := range output {
			if textField(item, "type") == "message" && textField(item, "role") == "assistant" {
				node := api.nodeLocked(s, textField(item, "id"))
				if node == nil || node.emitted {
					continue
				}
				var content []contracts.RawObject
				_ = json.Unmarshal(item["content"], &content)
				texts := []string{}
				for _, part := range content {
					if textField(part, "type") == "audio" || textField(part, "type") == "output_audio" {
						if text := textField(part, "transcript"); text != "" {
							texts = append(texts, text)
						}
					}
				}
				text := strings.Join(texts, "\n")
				if textField(response, "status") == "completed" && string(response["conversation_id"]) != "null" && textField(item, "status") == "completed" && text != "" {
					node.state = "final"
					node.text = text
				} else {
					node.state = "skip"
					node.text = ""
				}
			}
		}
		if textField(response, "status") == "completed" {
			for _, item := range output {
				if s.stopping || textField(item, "type") != "function_call" || textField(item, "status") != "" && textField(item, "status") != "completed" {
					continue
				}
				id := textField(item, "call_id")
				name := textField(item, "name")
				if id == "" || contracts.UTF16Length(id) > 200 || s.tools[id] {
					continue
				}
				if len(s.tools) >= maxAPITools {
					fatal = ErrVoiceBusy
					break
				}
				s.tools[id] = true
				tool := apiTool{id, name, item["arguments"]}
				if len(tool.arguments) == 0 {
					tool.arguments = json.RawMessage(`{}`)
				}
				select {
				case s.toolQueue <- tool:
					s.pendingTools++
				default:
					fatal = ErrVoiceBusy
				}
			}
		}
	case "error":
		switch textField(eventError, "code") {
		case "invalid_api_key":
			fatal = voiceHTTPError(401)
		case "model_not_found":
			fatal = voiceHTTPError(404)
		case "insufficient_quota", "rate_limit_exceeded":
			fatal = voiceHTTPError(429)
		case "response_already_in_progress":
			s.needsResponse = true
			s.activeResponse = true
		}
	}
	api.flushConversationLocked(s)
	api.mu.Unlock()
	if usage != nil && api.options.Usage != nil {
		api.options.Usage(usage)
	}
	if fatal != nil {
		api.fail(s, fatal)
		return
	}
	api.respond(s)
}

func (api *API) toolLoop(s *apiSession) {
	defer s.workers.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case tool := <-s.toolQueue:
			args, err := voiceToolArguments(tool.name, tool.arguments)
			end := err == nil && tool.name == "end_call"
			result := json.RawMessage(`{"success":false,"error":"The coworker could not complete this voice tool. Check the chat for details."}`)
			ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute)
			if err == nil && tool.name == "run_task" {
				bounded, stop := context.WithTimeout(ctx, api.options.RequestTimeout)
				err = api.drainConversation(bounded, s)
				stop()
			}
			if err == nil && !api.current(s) {
				err = ErrVoiceCancelled
			}
			if err == nil {
				owner := work.ToolContext{CallID: s.callID, Owner: s.callID, IsCurrent: func() bool { return api.current(s) }}
				if end {
					result = json.RawMessage(`{"ended":true}`)
				} else if tool.name == "run_task" {
					result, err = api.options.RunTask(ctx, textField(args, "text"), owner)
				} else {
					result, err = api.options.Tool(ctx, tool.name, args, owner)
				}
			}
			if err != nil {
				result = json.RawMessage(`{"success":false,"error":"The coworker could not complete this voice tool. Check the chat for details."}`)
			} else if len(result) == 0 {
				result = json.RawMessage(`{"success":true}`)
			}
			cancel()
			output := api.redact(s, string(result))
			sendCtx, sendCancel := context.WithTimeout(s.ctx, api.options.RequestTimeout)
			if api.current(s) {
				err = api.write(sendCtx, s, object(map[string]any{"type": "conversation.item.create", "item": map[string]any{"type": "function_call_output", "call_id": tool.id, "output": output}}))
			}
			sendCancel()
			api.mu.Lock()
			s.pendingTools--
			if api.session == s && !s.closed && !s.stopping && !end {
				s.needsResponse = true
			}
			api.mu.Unlock()
			if end && err == nil {
				s.cleanupOnce.Do(func() { go api.finishSession(s, "tool") })
				return
			}
			if err != nil && api.current(s) {
				api.fail(s, ErrVoiceConnection)
				return
			}
			api.respond(s)
		}
	}
}
