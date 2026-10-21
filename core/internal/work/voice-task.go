package work

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const (
	maxPrivateVoiceTasks = 64
	voiceTaskFenceKey    = "voiceTaskSubmissions"
	voiceTaskInstruction = "Task requested during a voice call. Execute it inside this conversation workspace and return a concise result for speech. If the call ends, continue accepted work and report results or problems in the existing chat. Do not copy speech transcripts into chat.\n\n"
)

type voiceTask struct {
	message    *contracts.ChatMessage
	callID     string
	background bool
	result     chan voiceTaskResult
}

type voiceTaskResult struct {
	value json.RawMessage
	err   error
}

type voiceTaskFence struct {
	ID             string                     `json:"id"`
	CallID         string                     `json:"callId"`
	ConversationID string                     `json:"conversationId"`
	Submission     contracts.SubmissionStatus `json:"submission"`
	TurnID         string                     `json:"turnId,omitempty"`
}

func unconfirmedVoiceTasks(state contracts.State) bool {
	encoded, present := state.Extra[voiceTaskFenceKey]
	if !present {
		return false
	}
	var fences []voiceTaskFence
	if json.Unmarshal(encoded, &fences) != nil || len(fences) > store.MaxWorkRecords {
		return true
	}
	for _, fence := range fences {
		if fence.Submission == contracts.SubmissionStatusSubmitting || fence.Submission == contracts.SubmissionStatusUnknown || fence.Submission == contracts.SubmissionStatusConfirmed {
			return true
		}
	}
	return false
}

func setVoiceTaskFence(state *contracts.State, fence voiceTaskFence, terminal bool) error {
	var fences []voiceTaskFence
	if encoded, present := state.Extra[voiceTaskFenceKey]; present && (json.Unmarshal(encoded, &fences) != nil || len(fences) > store.MaxWorkRecords) {
		return store.ErrInvalidState
	}
	fences = slices.DeleteFunc(fences, func(prior voiceTaskFence) bool { return prior.ID == fence.ID })
	if !terminal {
		if len(fences) >= store.MaxWorkRecords {
			return runtime.ErrBackpressure
		}
		fences = append(fences, fence)
	}
	if state.Extra == nil {
		state.Extra = make(contracts.RawObject)
	}
	state.Extra[voiceTaskFenceKey] = raw(fences)
	return nil
}

// RunVoiceTask admits explicit API-call work into the same execution lane as
// chat work. Media cancellation ends only the waiter, never accepted execution.
func (value *Engine) RunVoiceTask(ctx context.Context, text string, owner ToolContext) (json.RawMessage, error) {
	if owner.CallID == "" || owner.IsCurrent == nil || !owner.IsCurrent() || contracts.TrimText(text) == "" {
		return nil, ErrStaleOwner
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	value.mu.Lock()
	call := value.CallSnapshot()
	if value.closed || value.maintenance || value.takeover || value.acquiring || value.paused || call == nil || call.ID != owner.CallID || call.Provider != "api" {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	if value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
		value.mu.Unlock()
		return nil, runtime.ErrDisconnected
	}
	if len(value.voiceTasks) >= maxPrivateVoiceTasks || len(value.queue) >= MaxQueue {
		value.mu.Unlock()
		return nil, runtime.ErrBackpressure
	}
	conversationID := value.store.ConversationID()
	if owner.ConversationID != "" && owner.ConversationID != conversationID {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	message := &contracts.ChatMessage{ID: "voice-task-" + value.options.NewID(), Role: contracts.RoleUser, Text: voiceTaskInstruction + text, WorkKind: "conversation"}
	task := &voiceTask{message: message, callID: owner.CallID, result: make(chan voiceTaskResult, 1)}
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return ErrStaleOwner
		}
		return setVoiceTaskFence(state, voiceTaskFence{ID: message.ID, CallID: owner.CallID, ConversationID: conversationID, Submission: contracts.SubmissionStatusNotSubmitted}, false)
	})
	if err != nil {
		value.mu.Unlock()
		return nil, err
	}
	value.voiceTasks[message.ID] = task
	value.queue = append(value.queue, message.ID)
	value.changeLocked()
	value.mu.Unlock()
	value.Wake()

	select {
	case result := <-task.result:
		return result.value, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-value.ctx.Done():
		return nil, ErrClosed
	}
}

func (value *Engine) updateExecutionMessage(active *execution, changes contracts.RawObject) error {
	if !active.voiceTask {
		_, err := value.store.UpdateConversation(value.ctx, active.conversationID, active.messageID, patch(changes))
		return err
	}
	return value.store.Mutate(value.ctx, func(state *contracts.State) error {
		if state.ConversationID != active.conversationID {
			return ErrStaleOwner
		}
		var submission contracts.SubmissionStatus
		if json.Unmarshal(changes["submission"], &submission) != nil {
			return store.ErrInvalidState
		}
		return setVoiceTaskFence(state, voiceTaskFence{ID: active.messageID, CallID: active.callID, ConversationID: active.conversationID, Submission: submission, TurnID: active.turnID}, false)
	})
}

// ContinueVoiceTasks is called after media has ended. Acknowledged work retains
// the same owner and reports in chat; known-unsubmitted queued work is retired.
func (value *Engine) ContinueVoiceTasks(callID string) error {
	value.mu.Lock()
	retired := []string{}
	for id, task := range value.voiceTasks {
		if task.callID != callID || task.background {
			continue
		}
		task.background = true
		if active := value.active; active != nil && active.messageID == id {
			active.nativeBackground = true
			if !active.startSubmitted {
				active.stopRequested = true
				active.cancelPreparation()
			}
			continue
		}
		retired = append(retired, id)
		value.queue = slices.DeleteFunc(value.queue, func(queued string) bool { return queued == id })
		delete(value.voiceTasks, id)
		task.result <- voiceTaskResult{err: ErrPaused}
	}
	value.changeLocked()
	value.mu.Unlock()
	if len(retired) > 0 {
		if err := value.store.Mutate(value.ctx, func(state *contracts.State) error {
			for _, id := range retired {
				if err := setVoiceTaskFence(state, voiceTaskFence{ID: id}, true); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
		value.notice("The call ended before the queued task was submitted. Send the request again in chat if it is still needed.")
	}
	value.Wake()
	return nil
}

func (value *Engine) pauseQueuedLocked(ctx context.Context, ids []string, reason string) error {
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		for _, id := range ids {
			if value.voiceTasks[id] != nil {
				if err := setVoiceTaskFence(state, voiceTaskFence{ID: id}, true); err != nil {
					return err
				}
				continue
			}
			message, err := store.FindMessage(state, id)
			if err != nil {
				return err
			}
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			message.PauseReason = contracts.Some(reason)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, id := range ids {
		if task := value.voiceTasks[id]; task != nil {
			delete(value.voiceTasks, id)
			task.result <- voiceTaskResult{err: ErrPaused}
		}
	}
	return nil
}
