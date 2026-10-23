package work

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const MaxPendingFollowups = 64

var clientMessageIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type AdmissionReceipt struct {
	Message         *contracts.ChatMessage
	Existing        bool
	Queued          bool
	CallID          string
	Provider        string
	SteerTurnID     string
	ContextCallID   string
	ContextProvider string
}

// AdmitExternalMessage admits an already persisted, authenticated integration
// message. It cannot create messages or weaken the public UUID client contract.
func (value *Engine) AdmitExternalMessage(ctx context.Context, conversationID string, input *contracts.ChatMessage) error {
	if input == nil || input.Role != contracts.RoleUser || eventString(input.Source, "type") != "telegram" || !strings.HasPrefix(input.ClientMessageID, "tg:") {
		return store.ErrInvalidState
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	state := value.store.Snapshot()
	if _, present := state.Extra[executorStopFenceKey]; present {
		return ErrUnknown
	}
	if state.ConversationID != conversationID {
		return ErrStaleOwner
	}
	stored, err := store.FindMessage(&state, input.ID)
	if err != nil || stored.Role != contracts.RoleUser || stored.ClientMessageID != input.ClientMessageID || string(raw(stored.Source)) != string(raw(input.Source)) || !sameMessageRequest(stored, input) {
		return ErrStaleOwner
	}
	if stored.TurnID.Value != "" || stored.Submission.Value == contracts.SubmissionStatusConfirmed {
		return nil
	}
	if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusDraft) && stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusQueued) {
		return ErrPaused
	}
	return value.enqueueLocked(ctx, stored)
}

func sameMessageRequest(left, right *contracts.ChatMessage) bool {
	leftText, leftErr := contracts.DecodeJSONTextUnits(messageTextJSON(left))
	rightText, rightErr := contracts.DecodeJSONTextUnits(messageTextJSON(right))
	if leftErr != nil || rightErr != nil || !slices.Equal(leftText, rightText) || left.ReplyTo.Value != right.ReplyTo.Value || len(left.Attachments) != len(right.Attachments) {
		return false
	}
	for index, file := range left.Attachments {
		if file.ID != right.Attachments[index].ID {
			return false
		}
	}
	if left.WorkReply == nil || right.WorkReply == nil {
		return left.WorkReply == nil && right.WorkReply == nil
	}
	return left.WorkReply.WorkID == right.WorkReply.WorkID && left.WorkReply.TurnID == right.WorkReply.TurnID && left.WorkReply.ConversationID == right.WorkReply.ConversationID
}

func messageTextJSON(message *contracts.ChatMessage) json.RawMessage {
	if message.LegacyText.Decoded["text"] == message.Text {
		if original, present := message.LegacyText.Original["text"]; present {
			return original
		}
	}
	return raw(message.Text)
}

// AdmitMessage atomically persists a human request and selects its one existing
// owner. Attachments must be validated current upload records from the owning
// file service; this boundary accepts no caller-supplied file paths or IDs alone.
func (value *Engine) AdmitMessage(ctx context.Context, conversationID string, input *contracts.ChatMessage) (AdmissionReceipt, error) {
	var receipt AdmissionReceipt
	if input == nil || input.Role != contracts.RoleUser || conversationID == "" {
		return receipt, store.ErrInvalidState
	}
	if input.ClientMessageID != "" && !clientMessageIDPattern.MatchString(input.ClientMessageID) {
		return receipt, store.ErrInvalidState
	}
	if len(input.Attachments) > MaxDeliveredFiles {
		return receipt, store.ErrInvalidState
	}
	fileIDs := []string{}
	for _, file := range input.Attachments {
		if file.ID == "" || slices.Contains(fileIDs, file.ID) {
			return receipt, store.ErrInvalidState
		}
		fileIDs = append(fileIDs, file.ID)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return receipt, store.ErrInvalidState
	}
	var message contracts.ChatMessage
	if json.Unmarshal(encoded, &message) != nil {
		return receipt, store.ErrInvalidState
	}
	message.Text = contracts.TrimText(message.Text)
	if message.Text == "" && len(message.Attachments) == 0 {
		return receipt, store.ErrInvalidState
	}
	if target := message.WorkReply; target != nil && (!clientMessageIDPattern.MatchString(message.ClientMessageID) || !workstate.ValidID(target.WorkID, workstate.IDLength) || !workstate.ValidID(target.TurnID, workstate.ReferenceIDLength) || target.ConversationID != conversationID) {
		return receipt, ErrStaleOwner
	}

	value.mu.Lock()
	if value.closed || value.maintenance {
		value.mu.Unlock()
		return receipt, ErrClosed
	}
	call := value.CallSnapshot()
	if call != nil {
		receipt.ContextCallID = call.ID
		receipt.ContextProvider = call.Provider
	}
	err = value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return ErrStaleOwner
		}
		if message.ClientMessageID != "" {
			if slices.Contains(state.DeletedClientMessageIDs, message.ClientMessageID) {
				return &contracts.APIError{Status: 409, Code: "message_deleted", Message: "This message was deleted from the current chat."}
			}
			for _, prior := range state.Messages {
				if prior.Role != contracts.RoleUser || prior.ClientMessageID != message.ClientMessageID {
					continue
				}
				if receipt.Existing || !sameMessageRequest(prior, &message) {
					return &contracts.APIError{Status: 409, Code: "client_message_conflict", Message: "This client message ID belongs to another request."}
				}
				receipt.Message = prior
				receipt.Existing = true
			}
			if receipt.Existing {
				return store.ErrNoChange
			}
		}
		if _, present := state.Extra[executorStopFenceKey]; present {
			return ErrUnknown
		}
		if value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
			return runtime.ErrDisconnected
		}
		if len(value.queue) >= MaxQueue {
			return runtime.ErrBackpressure
		}
		if message.ReplyTo.Value != "" {
			if _, err := store.FindMessage(state, message.ReplyTo.Value); err != nil {
				return ErrStaleOwner
			}
		}
		if message.ID == "" {
			message.ID = value.options.NewID()
		}
		if !workstate.ValidID(message.ID, workstate.IDLength) {
			return store.ErrInvalidState
		}
		for _, prior := range state.Messages {
			if prior.ID == message.ID {
				return store.ErrMessageConflict
			}
		}
		message.Time = contracts.Some(value.Timestamp())
		message.ReceivedAt = contracts.Some(value.Timestamp())
		message.ExecutorConfirmedAt = contracts.Null[float64]()
		message.Read = false
		message.Reactions = []string{}
		message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))
		message.Submission = contracts.Some(contracts.SubmissionStatusNotSubmitted)
		message.UnknownOutcome = false
		message.WorkKind = "conversation"
		message.QueuedAt = contracts.Some(value.Timestamp())
		receipt.Queued = true
		if target := message.WorkReply; target != nil {
			record, err := store.FindWork(state, target.WorkID)
			if err != nil || record.TurnID != target.TurnID || workstate.Unconfirmed(record) {
				return ErrStaleOwner
			}
			message.WorkID = record.ID
			message.WorkKind = "task"
			if active := value.active; active != nil && active.turnID == record.TurnID && active.workID == record.ID {
				if !active.startAcknowledged || active.finishing || active.stopRequested || active.unknown {
					return ErrUnknown
				}
				receipt.SteerTurnID = active.turnID
				receipt.Queued = false
			} else if !workstate.ReplyEligible(record, value.Timestamp()) {
				return ErrStaleOwner
			}
		} else if call != nil && message.Text != "" && len(message.Attachments) == 0 {
			receipt.CallID = call.ID
			receipt.Provider = call.Provider
			receipt.Queued = false
		} else if call != nil && call.Provider == "subscription" {
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			message.PauseReason = contracts.Some(pauseReasonVoiceCall)
			receipt.Queued = false
		} else if active := value.active; active != nil && active.startAcknowledged && active.attemptID == "" && !active.finishing && !active.stopRequested && !active.unknown && (!active.nativeVoice || active.nativeBackground) {
			if len(value.pendingFollowups) >= MaxPendingFollowups {
				return runtime.ErrBackpressure
			}
			receipt.SteerTurnID = active.turnID
			receipt.Queued = false
		}
		if reason := value.admissionPauseReasonLocked(); reason != "" {
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			message.PauseReason = contracts.Some(reason)
			receipt.Queued = false
			receipt.CallID = ""
			receipt.SteerTurnID = ""
		}
		state.Messages = append(state.Messages, &message)
		receipt.Message = &message
		return nil
	})
	if err != nil {
		value.mu.Unlock()
		return AdmissionReceipt{}, err
	}
	if receipt.Existing {
		value.mu.Unlock()
		return receipt, nil
	}
	if receipt.Queued {
		value.queue = append(value.queue, message.ID)
	}
	value.changeLocked()
	if receipt.SteerTurnID != "" {
		value.pendingFollowups[message.ID] = true
		value.workers.Add(1)
		go func() {
			defer value.workers.Done()
			if _, err := value.followup(value.ctx, &message, receipt.SteerTurnID, true); err != nil {
				value.notice("The task could not confirm the new message. Check its state before sending it again.")
			}
		}()
	}
	value.mu.Unlock()
	value.Wake()
	return receipt, nil
}
