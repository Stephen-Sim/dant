package voice

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const nativeConversationIDLimit = 128

var clientInputID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

func pendingHandoffs(s *nativeSession) bool {
	for _, value := range s.handoffs {
		if value.turnID == "" && !value.idleConfirmed {
			return true
		}
	}
	return false
}

func (native *Native) queue(s *nativeSession) (*ContextQueue, error) {
	native.mu.Lock()
	defer native.mu.Unlock()
	if s.contextQueue != nil {
		return s.contextQueue, nil
	}
	generation, callID := s.generation, s.mediaID
	queue, err := NewContextQueue(s.ctx, ContextQueueOptions{
		CallID:    callID,
		Timeout:   native.options.ContextTimeout,
		IsCurrent: func() bool { return native.current(s, generation) },
		Send: func(ctx context.Context, input ContextInput) error {
			if !native.current(s, generation) {
				return ErrContextRejected
			}
			text := input.Text
			if input.Kind == "input" {
				snapshot := native.options.Engine.Snapshot()
				state := native.options.Store.Snapshot()
				message := findCallMessage(state, input.MessageID)
				native.mu.Lock()
				entry := s.callInputs[input.MessageID]
				allowed := native.session == s && entry != nil && entry.epoch == s.workEpoch && !s.unknown && !s.pausing && !pendingHandoffs(s) && s.generation == generation && !snapshot.Takeover && !snapshot.Acquiring
				native.mu.Unlock()
				if !allowed || message == nil || entry.isCurrent != nil && !entry.isCurrent() {
					return ErrContextRejected
				}
				if _, err := native.options.Store.UpdateConversation(ctx, state.ConversationID, message.ID, contracts.MessagePatch{"status": rawValue(contracts.TaskStatusQueued), "submission": rawValue(contracts.SubmissionStatusSubmitting), "voiceCallId": rawValue(callID)}); err != nil {
					return ErrContextRejected
				}
				native.mu.Lock()
				if native.session != s || s.generation != generation || entry.epoch != s.workEpoch {
					native.mu.Unlock()
					return ErrContextRejected
				}
				entry.dispatched = true
				native.mu.Unlock()
			}
			native.mu.Lock()
			thread := s.threadID
			native.mu.Unlock()
			if thread == "" {
				return ErrContextRejected
			}
			_, err := native.options.Worker.Request(ctx, "thread/realtime/appendText", object(map[string]any{"threadId": thread, "text": text}))
			var rejection *runtime.OperationError
			if errors.As(err, &rejection) && !rejection.UnknownOutcome {
				return ErrContextRejected
			}
			return err
		},
	})
	if err != nil {
		return nil, err
	}
	s.contextQueue = queue
	return queue, nil
}

func findCallMessage(state contracts.State, id string) *contracts.ChatMessage {
	for _, message := range state.Messages {
		if message != nil && message.ID == id {
			return message
		}
	}
	return nil
}

func (native *Native) SyncMemory(ctx context.Context, callID, memory string) ContextResult {
	native.mu.Lock()
	s := native.session
	valid := s != nil && s.mediaID == callID && !s.stopping && !s.closed && (s.status == contracts.VoiceCallStatusNegotiating || s.status == contracts.VoiceCallStatusConnected)
	native.mu.Unlock()
	if !valid {
		return ContextResult{CallID: callID, Kind: "memory", Status: contracts.LiveContextStatusCancelled}
	}
	queue, err := native.queue(s)
	if err != nil {
		return ContextResult{CallID: callID, Kind: "memory", Status: contracts.LiveContextStatusFailed}
	}
	return queue.Enqueue(ctx, ContextInput{Key: "memory", Kind: "memory", Text: BuildMemoryContext(memory)})
}

func (native *Native) SyncContext(ctx context.Context, callID, kind string, message *contracts.ChatMessage) ContextResult {
	native.mu.Lock()
	s := native.session
	valid := s != nil && s.mediaID == callID && !s.stopping && !s.closed && (s.status == contracts.VoiceCallStatusNegotiating || s.status == contracts.VoiceCallStatusConnected)
	native.mu.Unlock()
	if !valid {
		return ContextResult{CallID: callID, Kind: kind, Status: contracts.LiveContextStatusCancelled}
	}
	text, err := BuildCallContext(kind, message, nil)
	if err != nil {
		return ContextResult{CallID: callID, Kind: kind, Status: contracts.LiveContextStatusFailed}
	}
	queue, err := native.queue(s)
	if err != nil {
		return ContextResult{CallID: callID, Kind: kind, Status: contracts.LiveContextStatusFailed}
	}
	return queue.Enqueue(ctx, ContextInput{Key: kind + ":" + message.ID, Kind: kind, MessageID: message.ID, Text: text})
}

func (native *Native) Message(ctx context.Context, input NativeMessage) (NativeMessageResult, error) {
	if !clientInputID.MatchString(input.ClientMessageID) || contracts.TrimText(input.Text) == "" {
		return NativeMessageResult{}, ErrCallInput
	}
	select {
	case native.intake <- struct{}{}:
		defer func() { <-native.intake }()
	case <-ctx.Done():
		return NativeMessageResult{}, ErrVoiceCancelled
	}

	state := native.options.Store.Snapshot()
	if input.ConversationID != nil {
		if *input.ConversationID == "" || len(*input.ConversationID) > nativeConversationIDLimit {
			return NativeMessageResult{}, ErrCallInput
		}
		if *input.ConversationID != state.ConversationID {
			return NativeMessageResult{}, ErrVoiceCancelled
		}
	}
	if slices.Contains(state.DeletedClientMessageIDs, input.ClientMessageID) {
		return NativeMessageResult{}, ErrCallInput
	}
	native.mu.Lock()
	s := native.session
	valid := s != nil && s.mediaID == input.CallID && (s.status == contracts.VoiceCallStatusNegotiating || s.status == contracts.VoiceCallStatusConnected) && !s.closed && !s.stopping
	native.mu.Unlock()
	if !valid {
		return NativeMessageResult{}, ErrVoiceCancelled
	}
	if input.ReplyTo != nil && *input.ReplyTo != "" && findCallMessage(state, *input.ReplyTo) == nil {
		return NativeMessageResult{}, ErrCallInput
	}
	for _, prior := range state.Messages {
		if prior == nil || prior.Role != contracts.RoleUser || prior.ClientMessageID != input.ClientMessageID {
			continue
		}
		reply, _ := prior.ReplyTo.Get()
		wanted := ""
		if input.ReplyTo != nil {
			wanted = *input.ReplyTo
		}
		if prior.Text != input.Text || reply != wanted || prior.VoiceCallID != input.CallID {
			return NativeMessageResult{}, ErrCallInput
		}
		submission, _ := prior.Submission.Get()
		return NativeMessageResult{Message: prior, CallID: input.CallID, Submission: submission, Duplicate: true, UnknownOutcome: submission == contracts.SubmissionStatusUnknown}, nil
	}
	native.mu.Lock()
	unavailable := native.session != s || s.unknown || s.pausing || pendingHandoffs(s)
	native.mu.Unlock()
	if unavailable {
		return NativeMessageResult{}, ErrNativeUnknown
	}
	reply := contracts.Null[string]()
	if input.ReplyTo != nil {
		reply = contracts.Some(*input.ReplyTo)
	}
	message, err := native.options.Store.AddConversation(ctx, state.ConversationID, &contracts.ChatMessage{
		Role:            contracts.RoleUser,
		Text:            input.Text,
		ReplyTo:         reply,
		ClientMessageID: input.ClientMessageID,
		VoiceCallID:     input.CallID,
		WorkKind:        "conversation",
		Status:          contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued)),
		Submission:      contracts.Some(contracts.SubmissionStatusPreparing),
		Attachments:     []contracts.Attachment{},
		Reactions:       []string{},
	})
	if err != nil {
		if errors.Is(err, store.ErrMessageConflict) {
			return NativeMessageResult{}, ErrVoiceCancelled
		}
		return NativeMessageResult{}, err
	}
	native.changed()
	return native.submitCallMessage(ctx, input.CallID, message, nil, func() bool {
		return native.options.Store.Snapshot().ConversationID == state.ConversationID
	})
}

func (native *Native) SubmitCallMessage(ctx context.Context, callID string, message *contracts.ChatMessage) (NativeMessageResult, error) {
	return native.submitCallMessage(ctx, callID, message, nil, nil)
}

// SubmitMessage preserves the exact call and recall captured by the chat admission.
func (native *Native) SubmitMessage(ctx context.Context, input MessageOptions) (NativeMessageResult, error) {
	return native.submitCallMessage(ctx, input.CallID, input.Message, input.MemoryReference, input.IsCurrent)
}

func (native *Native) submitCallMessage(
	ctx context.Context,
	callID string,
	message *contracts.ChatMessage,
	reference func() string,
	isCurrent func() bool,
) (NativeMessageResult, error) {
	state := native.options.Store.Snapshot()
	if message == nil || message.Role != contracts.RoleUser || contracts.TrimText(message.Text) == "" || len(message.Attachments) > 0 {
		return NativeMessageResult{}, ErrCallInput
	}
	saved := findCallMessage(state, message.ID)
	if saved == nil || saved.Text != message.Text || saved.VoiceCallID != "" && saved.VoiceCallID != callID {
		return NativeMessageResult{}, ErrCallInput
	}
	native.mu.Lock()
	s := native.session
	if s == nil || s.mediaID != callID || s.closed || s.stopping || (s.status != contracts.VoiceCallStatusNegotiating && s.status != contracts.VoiceCallStatusConnected) {
		native.mu.Unlock()
		return NativeMessageResult{}, &VoiceInputError{"voice_call_changed", contracts.SubmissionStatusNotSubmitted, false}
	}
	if previous := s.callInputs[message.ID]; previous != nil {
		native.mu.Unlock()
		select {
		case <-previous.done:
			return previous.result, previous.err
		case <-ctx.Done():
			return NativeMessageResult{}, &VoiceInputError{"voice_input_unconfirmed", contracts.SubmissionStatusUnknown, true}
		}
	}
	submission, _ := saved.Submission.Get()
	if saved.UnknownOutcome || submission == contracts.SubmissionStatusSubmitting || submission == contracts.SubmissionStatusUnknown || submission == contracts.SubmissionStatusConfirmed || submission == contracts.SubmissionStatusRejected {
		native.mu.Unlock()
		return NativeMessageResult{}, &VoiceInputError{"voice_input_already_attempted", submission, saved.UnknownOutcome || submission == contracts.SubmissionStatusUnknown}
	}
	if s.unknown || s.pausing || pendingHandoffs(s) {
		native.mu.Unlock()
		return NativeMessageResult{}, &VoiceInputError{"voice_input_unavailable", contracts.SubmissionStatusNotSubmitted, false}
	}
	entry := &nativeInput{epoch: s.workEpoch, generation: s.generation, done: make(chan struct{}), isCurrent: isCurrent}
	s.callInputs[message.ID] = entry
	native.mu.Unlock()
	defer close(entry.done)
	var quoted *contracts.ChatMessage
	if id, ok := message.ReplyTo.Get(); ok {
		quoted = findCallMessage(state, id)
	}
	text, err := BuildCallInput(message, quoted, native.options.Redact)
	if err == nil {
		var recalled string
		if reference != nil {
			recalled = reference()
		} else if native.options.MemoryReference != nil {
			recalled, err = native.options.MemoryReference(ctx, saved)
		}
		if ctx.Err() != nil || isCurrent != nil && !isCurrent() || !native.current(s, entry.generation) {
			err = ErrVoiceCancelled
		}
		if err == nil && recalled != "" {
			text += "\n\n" + recalled
		}
	}
	if err == nil {
		if native.options.RememberCallInput == nil {
			err = ErrVoiceContext
		} else {
			err = native.options.RememberCallInput(ctx, saved, callID)
		}
	}
	voiceContext := ContextResult{CallID: callID, MessageID: message.ID, Kind: "input", Status: contracts.LiveContextStatusFailed}
	if err == nil {
		queue, queueErr := native.queue(s)
		err = queueErr
		if err == nil {
			voiceContext = queue.Enqueue(ctx, ContextInput{Key: "input:" + message.ID, Text: text, Kind: "input", MessageID: message.ID})
		}
	}
	native.mu.Lock()
	entry.settled = true
	dispatched := entry.dispatched
	unknown := dispatched && voiceContext.Status != contracts.LiveContextStatusSubmitted && voiceContext.Status != contracts.LiveContextStatusFailed
	var referenceError *VoiceInputError
	if errors.As(err, &referenceError) && referenceError.UnknownOutcome {
		unknown = true
	}
	if unknown {
		s.unknown = true
	}
	native.mu.Unlock()
	patch := contracts.MessagePatch{"voiceCallId": rawValue(callID), "voiceContext": rawValue(voiceContext)}
	if err == nil && voiceContext.Status == contracts.LiveContextStatusSubmitted {
		patch["status"] = rawValue(contracts.TaskStatusAccepted)
		patch["submission"] = rawValue(contracts.SubmissionStatusConfirmed)
		patch["executorConfirmedAt"] = rawValue(native.options.Now().UnixMilli())
		patch["pauseReason"] = json.RawMessage("null")
		patch["error"] = json.RawMessage("null")
		saved, err = native.options.Store.UpdateConversation(ctx, state.ConversationID, message.ID, patch)
		entry.result = NativeMessageResult{Message: saved, CallID: callID, Submission: contracts.SubmissionStatusConfirmed, VoiceContext: &voiceContext}
		entry.err = err
		native.changed()
		return entry.result, err
	}
	status := contracts.TaskStatusPaused
	next := contracts.SubmissionStatusPreparing
	reason := "voice-input-unavailable"
	wireSubmission := contracts.SubmissionStatusNotSubmitted
	if unknown {
		next = contracts.SubmissionStatusUnknown
		reason = "submission-unknown"
		wireSubmission = contracts.SubmissionStatusUnknown
	} else if dispatched {
		status = contracts.TaskStatusFailed
		next = contracts.SubmissionStatusRejected
		wireSubmission = contracts.SubmissionStatusRejected
	}
	patch["status"] = rawValue(status)
	patch["submission"] = rawValue(next)
	patch["pauseReason"] = rawValue(reason)
	patch["error"] = rawValue("The current call did not accept this typed message.")
	bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, saveErr := native.options.Store.UpdateConversation(bounded, state.ConversationID, message.ID, patch)
	entry.err = &VoiceInputError{"voice_input_unconfirmed", wireSubmission, unknown}
	if saveErr != nil {
		entry.err = saveErr
	}
	native.changed()
	return NativeMessageResult{}, entry.err
}
