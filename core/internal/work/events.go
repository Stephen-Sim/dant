package work

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func eventString(object contracts.RawObject, key string) string {
	var value string
	if !contracts.ValidUnicodeJSON(object[key]) || json.Unmarshal(object[key], &value) != nil {
		return ""
	}
	return value
}

func eventTurn(event runtime.Event) string {
	if id := eventString(event.Params, "turnId"); id != "" {
		return id
	}
	object, err := contracts.DecodeObject(event.Params["turn"], runtime.MaxRPCFrameBytes)
	if err == nil {
		return eventString(object, "id")
	}
	return ""
}

func boundedID(values []string, id string) []string {
	if id == "" || slices.Contains(values, id) {
		return values
	}
	values = append(values, id)
	if len(values) > MaxCompletedIDs {
		values = values[len(values)-MaxCompletedIDs:]
	}
	return values
}

func (value *Engine) Handle(ctx context.Context, event runtime.Event) error {
	return value.handleEvent(ctx, event, true)
}

func (value *Engine) handleEvent(ctx context.Context, event runtime.Event, routeMedia bool) error {
	return value.handleBoundEvent(ctx, event, routeMedia, nil)
}

func (value *Engine) handleBoundEvent(ctx context.Context, event runtime.Event, routeMedia bool, bound *execution) error {
	event = value.scopeMediaEvent(event)
	if event.Method == "thread/tokenUsage/updated" && value.options.Usage != nil {
		state := value.store.Snapshot()
		if eventString(event.Params, "threadId") == state.ThreadID.Value {
			changed, err := value.options.Usage.ObserveCodex(ctx, value.worker.RuntimeID(), raw(event.Params))
			if err != nil {
				value.notice("Token usage could not be saved.")
			} else if changed {
				value.Change()
			}
		}
	}
	if routeMedia && value.options.Calls != nil && value.options.Calls.OwnsEvent(event) {
		return value.options.Calls.HandleEvent(ctx, event)
	}
	value.mu.Lock()
	active := value.active
	if bound != nil && active != bound || active != nil && active.conversationOnly && bound != active {
		value.mu.Unlock()
		if bound != nil {
			return nil
		}
		return value.rejectEvent(ctx, event)
	}
	turnID := eventTurn(event)
	threadID := eventString(event.Params, "threadId")
	isTurn := strings.HasPrefix(event.Method, "turn/") || strings.HasPrefix(event.Method, "item/")
	if value.closed {
		value.mu.Unlock()
		return ErrClosed
	}
	if isTurn && (active == nil || active.finishing || threadID != "" && active.threadID != "" && threadID != active.threadID || turnID != "" && slices.Contains(value.completedTurns, turnID)) {
		value.mu.Unlock()
		return value.rejectEvent(ctx, event)
	}
	if isTurn && active != nil && active.startSubmitted && !active.startAcknowledged {
		rawEvent, _ := json.Marshal(event)
		size := len(rawEvent)
		if len(active.early) >= MaxEarlyEvents || active.earlyBytes+size > MaxEarlyBytes {
			value.mu.Unlock()
			return value.rejectEvent(ctx, event)
		}
		active.early = append(active.early, event)
		active.earlyBytes += size
		value.mu.Unlock()
		return nil
	}
	if isTurn && (active == nil || !active.startAcknowledged || turnID != "" && turnID != active.turnID || !value.currentLocked(active)) {
		value.mu.Unlock()
		return value.rejectEvent(ctx, event)
	}
	if event.IsRequest() {
		value.mu.Unlock()
		return value.handleRequest(ctx, event, active)
	}
	if active == nil {
		value.mu.Unlock()
		return nil
	}
	active.updatedAt = value.Timestamp()
	if event.Method == "turn/plan/updated" {
		var steps []contracts.PlanStep
		if json.Unmarshal(event.Params["plan"], &steps) == nil {
			plan, err := workstate.PublicPlan(steps, value.redact)
			if err == nil {
				workID, title, source := "", plan.Steps[0].Step, "chat"
				if active.record != nil {
					workID = active.record.ID
					if active.record.Plan != nil {
						title = active.record.Title
					}
				}
				if active.nativeVoice {
					source = "voice"
				}
				status := contracts.WorkStatusRunning
				if active.waiting || active.planWaiting || active.credentialWaits > 0 {
					status = contracts.WorkStatusWaitingUser
					for _, step := range plan.Steps {
						if step.Status == contracts.PlanStepStatusInProgress {
							value.mu.Unlock()
							return workstate.ErrInvalidPlan
						}
					}
					if plan.Completed == plan.Total {
						value.mu.Unlock()
						return workstate.ErrInvalidPlan
					}
				}
				record, err := value.store.RegisterWork(value.ctx, store.RegisterWorkOptions{WorkID: workID, TurnID: active.turnID, MessageID: active.messageID, Title: title, Source: source, Plan: &plan, Observed: true, StartedAt: active.startedAt, Status: status})
				if err == nil {
					active.record = record
					active.workID = record.ID
					err = value.refreshProjectLocked(value.ctx, record, active.messageIDs)
				}
				if err != nil {
					value.signalLocked("notice", raw("The public task plan could not be saved."))
				}
			}
		}
		value.changeLocked()
		value.mu.Unlock()
		return nil
	}
	if event.Method == "item/agentMessage/delta" {
		itemID := eventString(event.Params, "itemId")
		var delta string
		if !workstate.ValidID(itemID, workstate.ReferenceIDLength) || json.Unmarshal(event.Params["delta"], &delta) != nil || slices.Contains(value.completedItems, itemID) {
			value.mu.Unlock()
			return nil
		}
		active.step = contracts.TaskProgressStageResponding
		previousText := value.redact(active.outputs[itemID])
		text := value.boundOutput(active, itemID, active.outputs[itemID]+delta)
		if active.nativeVoice || active.attemptID != "" && !active.humanResponse {
			value.changeLocked()
			value.mu.Unlock()
			return nil
		}
		messageID := active.items[itemID]
		if messageID == "" {
			message, err := value.store.Add(value.ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Status: contracts.Some(contracts.MessageStatusStreaming), TaskID: contracts.Some(active.messageID)})
			if err != nil {
				value.mu.Unlock()
				return err
			}
			messageID = message.ID
			active.items[itemID] = messageID
			active.assistantIDs = append(active.assistantIDs, messageID)
		}
		_, err := value.store.Update(value.ctx, messageID, patch(contracts.RawObject{"text": raw(value.redact(text))}))
		redacted := value.redact(text)
		if err == nil && strings.HasPrefix(redacted, previousText) {
			value.signalLocked("delta", raw(contracts.RawObject{"id": raw(messageID), "delta": raw(strings.TrimPrefix(redacted, previousText))}))
		}
		value.changeLocked()
		value.mu.Unlock()
		return err
	}
	if event.Method == "item/started" || event.Method == "item/completed" {
		item, err := contracts.DecodeObject(event.Params["item"], runtime.MaxRPCFrameBytes)
		if err == nil {
			typeName := eventString(item, "type")
			itemID := eventString(item, "id")
			if event.Method == "item/completed" && typeName == "agentMessage" && !slices.Contains(value.completedItems, itemID) {
				var text string
				if json.Unmarshal(item["text"], &text) != nil {
					value.mu.Unlock()
					return runtime.ErrInvalidProtocol
				}
				text = value.boundOutput(active, itemID, text)
				if active.outputMeta == nil {
					active.outputMeta = make(map[string]quietOutput)
				}
				active.outputMeta[itemID] = quietOutput{text: text, phase: eventString(item, "phase"), ready: active.record != nil && !workstate.Unfinished(active.record), waiting: active.planWaiting || active.waiting}
				if active.nativeVoice || active.attemptID != "" && !active.humanResponse {
					value.completedItems = boundedID(value.completedItems, itemID)
					value.changeLocked()
					value.mu.Unlock()
					if active.attemptID != "" && !active.humanResponse {
						value.archiveOutputLinks(ctx, active, text)
					}
					return nil
				}
				messageID := active.items[itemID]
				if messageID == "" {
					message, err := value.store.Add(value.ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: value.redact(text), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), TaskID: contracts.Some(active.messageID)})
					if err != nil {
						value.mu.Unlock()
						return err
					}
					messageID = message.ID
					active.assistantIDs = append(active.assistantIDs, messageID)
					active.items[itemID] = messageID
				} else {
					if _, err := value.store.Update(value.ctx, messageID, patch(contracts.RawObject{"text": raw(value.redact(text)), "status": raw(contracts.TaskStatusCompleted)})); err != nil {
						value.mu.Unlock()
						return err
					}
				}
				value.completedItems = boundedID(value.completedItems, itemID)
			}
			if event.TaskExecutionObserved || executionItem(typeName, eventString(item, "tool")) {
				active.workObserved = true
				active.step = progressStep(typeName)
				if active.record == nil && active.turnID != "" {
					source, title := "chat", "Task from chat"
					if active.nativeVoice {
						source = "voice"
						title = "Task from a call"
					}
					record, err := value.store.RegisterWork(value.ctx, store.RegisterWorkOptions{TurnID: active.turnID, MessageID: active.messageID, Source: source, Title: title, Observed: true})
					if err == nil {
						active.record = record
						active.workID = record.ID
					}
				}
			}
		}
		value.changeLocked()
		if err == nil && event.Method == "item/completed" && eventString(item, "type") == "mcpToolCall" {
			owner := value.ownerLocked(active)
			value.mu.Unlock()
			return value.acceptMCPResult(ctx, active, item, owner)
		}
	}
	if event.Method == "turn/completed" {
		active.terminal = true
		turn, _ := contracts.DecodeObject(event.Params["turn"], runtime.MaxRPCFrameBytes)
		status := contracts.TaskStatus(eventString(turn, "status"))
		value.mu.Unlock()
		return value.finish(active, status, "")
	}
	value.mu.Unlock()
	return nil
}

func (value *Engine) redact(text string) string {
	if value.options.Redact != nil {
		return value.options.Redact(value.ctx, text)
	}
	return text
}

func (value *Engine) boundOutput(active *execution, itemID, text string) string {
	if _, exists := active.outputs[itemID]; !exists && len(active.outputs) >= workstate.ObservedItems {
		return ""
	}
	if _, exists := active.outputs[itemID]; !exists {
		active.outputOrder = append(active.outputOrder, itemID)
	}
	other := 0
	for id, value := range active.outputs {
		if id != itemID {
			other += contracts.UTF16Length(value)
		}
	}
	limit := max(0, runtimeOutputCharacters-other)
	text = workstate.SliceText(text, min(runtimeOutputCharacters, limit))
	active.outputs[itemID] = text
	return text
}

func (value *Engine) rejectEvent(ctx context.Context, event runtime.Event) error {
	if !event.IsRequest() {
		return nil
	}
	return value.replyRequestError(ctx, event, "Inactive or invalid execution owner")
}

func (value *Engine) handleRequest(ctx context.Context, event runtime.Event, active *execution) error {
	if active == nil {
		return value.rejectEvent(ctx, event)
	}
	if event.Method == "item/tool/requestUserInput" {
		if active.nativeBackground || active.attemptID != "" {
			return value.requestChatInput(ctx, event, active)
		}
		value.mu.Lock()
		if !value.currentLocked(active) {
			value.mu.Unlock()
			return value.rejectEvent(ctx, event)
		}
		if _, exists := value.pendingRequests[event.ID.Value.Key()]; exists {
			value.mu.Unlock()
			return nil
		}
		if len(value.pendingRequests) >= maxPendingUserRequests {
			value.mu.Unlock()
			return value.replyRequestError(ctx, event, "The input request limit was reached.")
		}
		active.waiting = true
		value.pendingRequests[event.ID.Value.Key()] = event
		value.signalLocked("user-input", raw(event))
		ids := append([]string{}, active.messageIDs...)
		value.changeLocked()
		value.mu.Unlock()
		for _, id := range ids {
			_, _ = value.store.Update(value.ctx, id, patch(contracts.RawObject{"status": raw(contracts.TaskStatusWaitingUser)}))
		}
		return nil
	}
	if event.Method != "item/tool/call" {
		return value.rejectEvent(ctx, event)
	}
	name := eventString(event.Params, "tool")
	arguments := event.Params["arguments"]
	var encoded string
	if json.Unmarshal(arguments, &encoded) == nil {
		arguments = []byte(encoded)
	}
	args, err := contracts.DecodeObject(arguments, runtime.MaxRPCFrameBytes)
	if err != nil {
		return value.rejectEvent(ctx, event)
	}
	value.mu.Lock()
	if !value.currentLocked(active) || !active.startAcknowledged || active.stopRequested {
		value.mu.Unlock()
		return value.rejectEvent(ctx, event)
	}
	owner := value.ownerLocked(active)
	if name == "end_call" {
		owner.CallID = event.MediaCallID.Value
	}
	value.mu.Unlock()
	result, toolErr := value.Tool(ctx, name, args, owner)
	success := toolErr == nil
	text := string(result)
	if !success {
		text = "The tool request was rejected or could not be confirmed."
	}
	response := raw(contracts.RawObject{"success": raw(success), "contentItems": raw([]contracts.RawObject{{"type": raw("inputText"), "text": raw(text)}})})
	return value.worker.Reply(ctx, event.ID.Value, response)
}

func (value *Engine) RespondToUser(ctx context.Context, id runtime.RPCID, result json.RawMessage) error {
	value.mu.Lock()
	event, exists := value.pendingRequests[id.Key()]
	active := value.active
	if !exists || active == nil || !value.currentLocked(active) {
		value.mu.Unlock()
		return ErrStaleOwner
	}
	delete(value.pendingRequests, id.Key())
	value.mu.Unlock()
	if err := value.worker.Reply(ctx, event.ID.Value, result); err != nil {
		return err
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if !value.currentLocked(active) || active.finishing || active.stopRequested || active.unknown {
		return ErrStaleOwner
	}
	active.waiting = len(value.pendingRequests) > 0
	if !active.waiting {
		active.planWaiting = false
	}
	if err := value.syncWaitingLocked(active); err != nil {
		return err
	}
	value.changeLocked()
	return nil
}

func executionItem(kind, tool string) bool {
	switch kind {
	case "commandExecution", "fileChange", "imageView", "imageGeneration", "webSearch", "collabAgentToolCall":
		return true
	case "mcpToolCall", "dynamicToolCall":
		switch tool {
		case "task_plan", "task_list", "task_cancel", "send_message", "send_chat_message", "end_call", "react_message", "memory_write", "skill_list", "skill_get", "credential_find", "credential_get", "schedule_list", "schedule_save", "schedule_delete":
			return false
		}
		return tool != ""
	}
	return false
}

func progressStep(kind string) contracts.TaskProgressStage {
	switch kind {
	case "commandExecution":
		return contracts.TaskProgressStageCommand
	case "fileChange", "imageGeneration":
		return contracts.TaskProgressStageFiles
	case "agentMessage":
		return contracts.TaskProgressStageResponding
	case "imageView", "mcpToolCall":
		return contracts.TaskProgressStageComputer
	default:
		return contracts.TaskProgressStageWorking
	}
}

func (value *Engine) finish(active *execution, status contracts.TaskStatus, reason string) error {
	value.mu.Lock()
	if value.active != active || active.finishing {
		value.mu.Unlock()
		return nil
	}
	// Before acknowledgement, the selected continuation owns settlement of its
	// durable claim. Stop paths cancel and join it rather than closing it twice.
	if active.selectedResume && !active.startAcknowledged {
		active.stopRequested = true
		if active.stopReason == "" || reason == pauseReasonDisconnected {
			active.stopReason = reason
		}
		active.cancelPreparation()
		value.mu.Unlock()
		deadline, cancel := context.WithTimeout(value.ctx, StopConfirmationTimeout)
		defer cancel()
		select {
		case <-active.stopped:
			return nil
		case <-deadline.Done():
			return ErrUnknown
		}
	}
	active.finishing = true
	active.cancelPreparation()
	conversationStopConfirmed := true
	if active.conversationOnly {
		value.mu.Unlock()
		closeErr := value.closeConversation(active)
		value.mu.Lock()
		if closeErr != nil {
			conversationStopConfirmed = false
			active.unknown = true
			reason = pauseReasonStopUnknown
			value.confirmedStopped = false
		}
	}
	if reason == "" || !active.startSubmitted && active.stopRequested && reason == pauseReasonRequestFailed {
		if active.stopReason != "" {
			reason = active.stopReason
		}
	}
	final := contracts.TaskStatusFailed
	if status == contracts.TaskStatusCompleted {
		final = contracts.TaskStatusReview
	} else if status == contracts.TaskStatusPaused || status == contracts.TaskStatusInterrupted {
		final = contracts.TaskStatusPaused
	}
	if active.cancelRequested && (status == contracts.TaskStatusInterrupted || !active.startSubmitted && status == contracts.TaskStatusPaused) {
		final = contracts.TaskStatusCancelled
	}
	if active.unknown {
		final = contracts.TaskStatusPaused
		value.pauseLocked(reason)
	}
	ids := append([]string{}, active.messageIDs...)
	assistantIDs := append([]string{}, active.assistantIDs...)
	conversationID := active.conversationID
	unknownOutcome := active.unknown
	voiceTask := active.voiceTask
	voiceFence := voiceTaskFence{
		ID: active.messageID, CallID: active.callID,
		ConversationID: conversationID, TurnID: active.turnID,
		Submission: contracts.SubmissionStatusUnknown,
	}
	knownUnsubmitted := !active.startAcknowledged && !unknownOutcome && (!active.startSubmitted || active.startRejected)
	value.mu.Unlock()

	err := value.store.Mutate(value.ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return ErrStaleOwner
		}
		if voiceTask {
			if err := setVoiceTaskFence(state, voiceFence, !unknownOutcome); err != nil {
				return err
			}
		}
		for _, id := range ids {
			message, err := store.FindMessage(state, id)
			if err != nil {
				continue
			}
			message.Status = contracts.Some(contracts.MessageStatus(final))
			message.Error = contracts.Null[string]()
			message.PauseReason = contracts.Null[string]()
			if knownUnsubmitted {
				message.Submission = contracts.Some(contracts.SubmissionStatusNotSubmitted)
			}
			if final == contracts.TaskStatusPaused {
				message.PauseReason = contracts.Some(reason)
			}
			if unknownOutcome {
				message.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
				message.UnknownOutcome = true
			}
			if final == contracts.TaskStatusCancelled {
				message.CancelledAt = contracts.Some(value.Timestamp())
			}
		}
		for _, id := range assistantIDs {
			message, err := store.FindMessage(state, id)
			if err == nil && message.Status.Value == contracts.MessageStatusStreaming {
				message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
				if status == contracts.TaskStatusCompleted {
					message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))
				}
			}
		}
		return nil
	})
	quietPublished := false
	if err == nil && active.attemptID != "" && !active.humanResponse {
		var messageID string
		messageID, quietPublished, err = value.publishContinuation(active, status, final)
		if messageID != "" {
			assistantIDs = append(assistantIDs, messageID)
		}
	}
	if err == nil && active.nativeVoice && active.nativeBackground && status == contracts.TaskStatusCompleted && len(active.outputOrder) > 0 {
		texts := []string{}
		for _, id := range active.outputOrder {
			if text := active.outputs[id]; contracts.TrimText(text) != "" {
				texts = append(texts, text)
			}
		}
		if len(texts) > 0 {
			message, saveErr := value.store.Add(value.ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: value.redact(strings.Join(texts, "\n\n")), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), WorkID: active.workID, Source: contracts.RawObject{"type": raw("voice-call"), "conversationId": raw(active.conversationID)}})
			if saveErr != nil {
				err = saveErr
			} else {
				assistantIDs = append(assistantIDs, message.ID)
				active.assistantIDs = append(active.assistantIDs, message.ID)
			}
		}
	}
	if err == nil && !active.conversationOnly && status == contracts.TaskStatusCompleted && (active.attemptID == "" || active.humanResponse || quietPublished) {
		value.archiveFinalOutputs(active)
		assistantIDs = append([]string{}, active.assistantIDs...)
	}
	if err == nil && active.record != nil {
		workStatus := contracts.WorkStatus(final)
		if final == contracts.TaskStatusReview {
			if active.waiting || active.planWaiting || active.credentialWaits > 0 {
				workStatus = contracts.WorkStatusWaitingUser
			} else if workstate.Unfinished(active.record) {
				workStatus = contracts.WorkStatusContinuing
			}
		}
		_, err = value.store.UpdateRegisteredWork(value.ctx, active.turnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(workStatus), ExecutionEnded: active.terminal || !active.startSubmitted, ExecutionObserved: active.workObserved})
		if err == nil {
			value.mu.Lock()
			err = value.refreshProjectLocked(value.ctx, active.record, active.messageIDs)
			value.mu.Unlock()
		}
	}
	if err == nil && status == contracts.TaskStatusCompleted && len(assistantIDs) > 0 {
		_, err = value.store.AddCompletion(value.ctx, active.turnID, assistantIDs, contracts.Some(active.messageID), nil)
	}
	value.mu.Lock()
	if err != nil {
		active.unknown = true
		value.pauseLocked(pauseReasonUnknown)
		active.finishing = false
		value.changeLocked()
		value.mu.Unlock()
		return err
	}
	value.completedTurns = boundedID(value.completedTurns, active.turnID)
	if value.active == active {
		value.active = nil
	}
	if task := value.voiceTasks[active.messageID]; task != nil {
		delete(value.voiceTasks, active.messageID)
		result := voiceTaskResult{err: ErrPaused}
		if status == contracts.TaskStatusCompleted && active.startAcknowledged && !active.stopRequested {
			texts := []string{}
			for _, id := range active.outputOrder {
				if text := active.outputs[id]; contracts.TrimText(text) != "" {
					texts = append(texts, text)
				}
			}
			text := value.redact(strings.Join(texts, "\n\n"))
			if text == "" {
				text = "Task completed."
			}
			result = voiceTaskResult{value: raw(contracts.RawObject{"result": raw(text)})}
		}
		task.result <- result
	}
	if (active.conversationOnly || active.terminal || !active.startSubmitted) && conversationStopConfirmed {
		value.confirmedStopped = true
	}
	close(active.stopped)
	value.pendingRequests = make(map[string]runtime.Event)
	value.changeLocked()
	value.mu.Unlock()
	if value.options.OwnerEnded != nil && active.turnID != "" {
		value.options.OwnerEnded(active.turnID)
	}
	if calls, ok := value.options.Calls.(ContinuationCalls); ok && active.nativeAdmission != nil {
		calls.FinishContinuationAdmission(*active.nativeAdmission)
	}
	value.Wake()
	return nil
}
