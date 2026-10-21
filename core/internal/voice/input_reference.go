package voice

import (
	"context"
	"errors"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

type ReferenceStatus string

const (
	ReferencePending   ReferenceStatus = "pending"
	ReferenceSubmitted ReferenceStatus = "submitted"
	ReferenceUnknown   ReferenceStatus = "unknown"
	ReferenceFailed    ReferenceStatus = "failed"
)

type ReferencePersistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
}

type ReferenceOptions struct {
	Store   ReferencePersistence
	Inject  func(context.Context, string, func() bool) (contracts.RawObject, error)
	Current func(conversationID, callID, messageID string) bool
	Redact  Redactor
	Now     func() time.Time
}

type InputReferences struct{ options ReferenceOptions }

func NewInputReferences(options ReferenceOptions) (*InputReferences, error) {
	if options.Store == nil || options.Inject == nil || options.Current == nil {
		return nil, ErrCallInput
	}
	if options.Redact == nil {
		options.Redact = func(text string) string { return text }
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &InputReferences{options: options}, nil
}

func (refs *InputReferences) Remember(ctx context.Context, message *contracts.ChatMessage, callID string) error {
	if message == nil || message.Role != contracts.RoleUser {
		return ErrCallInput
	}
	state := refs.options.Store.Snapshot()
	conversation := state.ConversationID
	current := func() bool { return refs.options.Current(conversation, callID, message.ID) }
	if !current() {
		return &VoiceInputError{"voice_context_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
	}
	saved := findCallMessage(state, message.ID)
	if saved == nil || saved.Text != message.Text || saved.VoiceCallID != "" && saved.VoiceCallID != callID {
		return ErrCallInput
	}
	var quoted *contracts.ChatMessage
	if id, ok := saved.ReplyTo.Get(); ok {
		quoted = findCallMessage(state, id)
	}
	text, err := BuildCallContext("message", saved, quoted)
	if err != nil {
		return err
	}
	quote, err := CallReply(saved, quoted, refs.options.Redact)
	if err != nil {
		return err
	}
	var reply *string
	if value, ok := saved.ReplyTo.Get(); ok && value != "" {
		reply = &value
	}
	at := float64(refs.options.Now().UnixMilli())
	if value, ok := saved.Time.Get(); ok {
		at = value
	}
	history := object(map[string]any{"conversationId": conversation, "callId": callID, "messageId": saved.ID, "role": "user", "text": refs.options.Redact(saved.Text), "replyTo": reply, "quotedMessage": quote, "attachments": attachmentNames(saved, refs.options.Redact), "at": at, "submission": ReferencePending})
	duplicate := false
	err = refs.options.Store.Mutate(ctx, func(latest *contracts.State) error {
		if latest.ConversationID != conversation {
			return ErrVoiceCancelled
		}
		owner := findCallMessage(*latest, saved.ID)
		if owner == nil || owner.Text != saved.Text || owner.VoiceCallID != "" && owner.VoiceCallID != callID {
			return ErrCallInput
		}
		if textField(owner.CallContext, "callId") == callID {
			if textField(owner.CallContext, "status") == string(ReferenceSubmitted) {
				duplicate = true
				return nil
			}
			unknown := textField(owner.CallContext, "status") == string(ReferencePending) || textField(owner.CallContext, "status") == string(ReferenceUnknown)
			if unknown {
				return &VoiceInputError{"voice_context_already_attempted", contracts.SubmissionStatusUnknown, true}
			}
			return &VoiceInputError{"voice_context_already_attempted", contracts.SubmissionStatusNotSubmitted, false}
		}
		for _, value := range latest.Messages {
			if value != nil && textField(value.CallContext, "callId") == callID && textField(value.CallContext, "status") == string(ReferenceUnknown) {
				return &VoiceInputError{"voice_context_unconfirmed", contracts.SubmissionStatusNotSubmitted, false}
			}
		}
		owner.CallContext = object(map[string]any{"callId": callID, "status": ReferencePending})
		setCallInputHistory(latest, callID, saved.ID, history, ReferencePending)
		return nil
	})
	if err != nil || duplicate {
		return err
	}
	if !current() {
		err = &VoiceInputError{"voice_context_not_submitted", contracts.SubmissionStatusNotSubmitted, false}
	} else {
		_, err = refs.options.Inject(ctx, text, current)
	}
	status := ReferenceSubmitted
	unknown := false
	if err != nil {
		status = ReferenceUnknown
		unknown = true
		var operation *runtime.OperationError
		var input *VoiceInputError
		if errors.As(err, &operation) && !operation.UnknownOutcome || errors.As(err, &input) && input.Submission == contracts.SubmissionStatusNotSubmitted {
			status = ReferenceFailed
			unknown = false
		}
	}
	bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	saveErr := refs.options.Store.Mutate(bounded, func(latest *contracts.State) error {
		if latest.ConversationID != conversation {
			return ErrVoiceCancelled
		}
		owner := findCallMessage(*latest, saved.ID)
		if owner == nil || owner.Text != saved.Text || textField(owner.CallContext, "callId") != callID || textField(owner.CallContext, "status") != string(ReferencePending) {
			return ErrVoiceCancelled
		}
		owner.CallContext = object(map[string]any{"callId": callID, "status": status})
		setCallInputHistory(latest, callID, saved.ID, history, status)
		return nil
	})
	if saveErr != nil {
		return &VoiceInputError{"voice_context_save_unconfirmed", contracts.SubmissionStatusUnknown, true}
	}
	if err != nil {
		return &VoiceInputError{"voice_context_unconfirmed", func() contracts.SubmissionStatus {
			if unknown {
				return contracts.SubmissionStatusUnknown
			}
			return contracts.SubmissionStatusNotSubmitted
		}(), unknown}
	}
	return nil
}

func setCallInputHistory(state *contracts.State, callID, messageID string, entry contracts.RawObject, status ReferenceStatus) {
	for index, raw := range state.CallInputHistory {
		value, err := contracts.DecodeObject(raw, len(raw))
		if err != nil {
			continue
		}
		if textField(value, "callId") == callID && textField(value, "messageId") == messageID {
			value["submission"] = rawValue(status)
			state.CallInputHistory[index] = rawValue(value)
			return
		}
	}
	entry["submission"] = rawValue(status)
	state.CallInputHistory = append(state.CallInputHistory, rawValue(entry))
}
