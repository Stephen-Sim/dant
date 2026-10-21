package voice

import (
	"context"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type MessageOptions struct {
	CallID          string
	Message, Reply  *contracts.ChatMessage
	IsCurrent       func() bool
	MemoryReference func() string
}

func (api *API) Message(ctx context.Context, input MessageOptions) (InputResult, error) {
	fail := func(code string, submission contracts.SubmissionStatus) (InputResult, error) {
		return InputResult{}, &VoiceInputError{Code: code, Submission: submission, UnknownOutcome: submission == contracts.SubmissionStatusUnknown}
	}
	api.mu.Lock()
	s := api.session
	valid := s != nil && s.callID == input.CallID && s.ready && s.status == contracts.VoiceCallStatusActive && !s.closed && !s.stopping
	api.mu.Unlock()
	if !valid {
		return fail("voice_call_not_current", contracts.SubmissionStatusNotSubmitted)
	}
	if input.IsCurrent != nil && !input.IsCurrent() {
		return fail("voice_input_paused", contracts.SubmissionStatusNotSubmitted)
	}
	message := input.Message
	if message == nil || message.Role != contracts.RoleUser || message.ID == "" || contracts.UTF16Length(message.ID) > 128 || contracts.TrimText(message.Text) == "" || len(message.Attachments) > 0 {
		return fail("voice_text_required", contracts.SubmissionStatusNotSubmitted)
	}
	text, err := BuildCallInput(message, input.Reply, func(text string) string { return api.redact(s, text) })
	if err != nil {
		return fail("invalid_call_input", contracts.SubmissionStatusNotSubmitted)
	}
	api.mu.Lock()
	if prior := s.messages[message.ID]; prior != nil {
		if prior.text != text {
			api.mu.Unlock()
			return fail("voice_input_identity_changed", contracts.SubmissionStatusNotSubmitted)
		}
		api.mu.Unlock()
		select {
		case <-prior.done:
			return prior.result, prior.err
		case <-ctx.Done():
			return fail("voice_input_unconfirmed", contracts.SubmissionStatusUnknown)
		}
	}
	if len(s.messages) >= 4096 {
		api.mu.Unlock()
		return fail("voice_input_limit", contracts.SubmissionStatusNotSubmitted)
	}
	entry := &apiInput{messageID: message.ID, text: text, itemID: "dant_" + strings.ReplaceAll(api.options.NewID(), "-", ""), eventID: api.options.NewID(), submission: contracts.SubmissionStatusPreparing, done: make(chan struct{}), ack: make(chan error, 1)}
	s.messages[message.ID] = entry
	api.mu.Unlock()
	defer close(entry.done)
	select {
	case s.messageGate <- struct{}{}:
	case <-ctx.Done():
		entry.err = &VoiceInputError{"voice_input_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
		return entry.result, entry.err
	case <-s.ctx.Done():
		entry.err = &VoiceInputError{"voice_input_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
		return entry.result, entry.err
	}
	defer func() { <-s.messageGate }()
	check := func() bool {
		if !api.current(s) || input.IsCurrent != nil && !input.IsCurrent() {
			return false
		}
		api.mu.Lock()
		defer api.mu.Unlock()
		return !s.inputUnknown
	}
	if !check() {
		entry.err = &VoiceInputError{"voice_input_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
		return entry.result, entry.err
	}
	bounded, cancel := context.WithTimeout(ctx, api.options.RequestTimeout)
	defer cancel()
	if err = api.drainConversation(bounded, s); err != nil || !check() {
		entry.err = &VoiceInputError{"voice_input_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
		return entry.result, entry.err
	}
	entry.inputText = entry.text
	if input.MemoryReference != nil {
		if reference := input.MemoryReference(); reference != "" {
			entry.inputText += "\n\n" + reference
		}
	}
	api.mu.Lock()
	if api.session != s || s.stopping || s.closed || s.inputUnknown {
		api.mu.Unlock()
		entry.err = &VoiceInputError{"voice_input_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
		return entry.result, entry.err
	}
	s.inputAck = entry
	entry.submission = contracts.SubmissionStatusSubmitting
	api.mu.Unlock()
	err = api.write(bounded, s, object(map[string]any{"type": "conversation.item.create", "event_id": entry.eventID, "item": map[string]any{"id": entry.itemID, "type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": entry.inputText}}}}))
	if err == nil {
		select {
		case err = <-entry.ack:
		case <-bounded.Done():
			err = ErrContextUnknown
		case <-s.ctx.Done():
			err = ErrVoiceCancelled
		}
	}
	api.mu.Lock()
	if s.inputAck == entry {
		s.inputAck = nil
	}
	submission := entry.submission
	confirmedAt := entry.confirmedAt
	if submission == contracts.SubmissionStatusConfirmed {
		entry.result = InputResult{entry.messageID, s.callID, contracts.LiveContextStatusSubmitted, contracts.SubmissionStatusConfirmed, confirmedAt}
		if api.session == s && !s.stopping && !s.closed {
			s.needsResponse = true
		}
		api.mu.Unlock()
		api.respond(s)
		return entry.result, nil
	}
	if submission == contracts.SubmissionStatusSubmitting {
		entry.submission = contracts.SubmissionStatusUnknown
		s.inputUnknown = true
		submission = contracts.SubmissionStatusUnknown
	}
	api.mu.Unlock()
	if submission != contracts.SubmissionStatusUnknown && submission != contracts.SubmissionStatusRejected {
		submission = contracts.SubmissionStatusNotSubmitted
	}
	entry.err = &VoiceInputError{"voice_input_unconfirmed", submission, submission == contracts.SubmissionStatusUnknown}
	return entry.result, entry.err
}
