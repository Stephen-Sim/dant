package store

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const MaxMessageIDLength = 128

func FindMessage(state *contracts.State, id string) (*contracts.ChatMessage, error) {
	if id == "" || len(id) > MaxMessageIDLength {
		return nil, ErrMessageNotFound
	}
	var found *contracts.ChatMessage
	for _, message := range state.Messages {
		if message != nil && message.ID == id {
			if found != nil {
				return nil, ErrMessageConflict
			}
			found = message
		}
	}
	if found == nil {
		return nil, ErrMessageNotFound
	}
	return found, nil
}

func (value *Store) Message(id string) (*contracts.ChatMessage, error) {
	value.mu.RLock()
	defer value.mu.RUnlock()
	message, err := FindMessage(&value.state, id)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return nil, ErrInvalidState
	}
	var copy contracts.ChatMessage
	if json.Unmarshal(encoded, &copy) != nil {
		return nil, ErrInvalidState
	}
	return &copy, nil
}

func (value *Store) Add(ctx context.Context, input *contracts.ChatMessage) (*contracts.ChatMessage, error) {
	return value.addMessage(ctx, "", input)
}

// AddConversation commits a message only within its captured conversation.
func (value *Store) AddConversation(ctx context.Context, conversationID string, input *contracts.ChatMessage) (*contracts.ChatMessage, error) {
	if conversationID == "" {
		return nil, ErrMessageConflict
	}
	return value.addMessage(ctx, conversationID, input)
}

func (value *Store) addMessage(ctx context.Context, conversationID string, input *contracts.ChatMessage) (*contracts.ChatMessage, error) {
	if input == nil || !input.Role.Valid() {
		return nil, ErrInvalidState
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, ErrInvalidState
	}
	var message contracts.ChatMessage
	if json.Unmarshal(encoded, &message) != nil {
		return nil, ErrInvalidState
	}
	if message.ID == "" {
		message.ID = value.newID()
	}
	if len(message.ID) > MaxMessageIDLength {
		return nil, ErrInvalidState
	}
	if !message.Time.Present {
		message.Time = contracts.Some(value.Timestamp())
	}
	if message.Reactions == nil {
		message.Reactions = []string{}
	}
	if message.Role == contracts.RoleUser {
		if !message.Status.Present {
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft))
		}
		if !message.ReceivedAt.Present {
			message.ReceivedAt = contracts.Some(value.Timestamp())
		}
		if !message.ExecutorConfirmedAt.Present {
			message.ExecutorConfirmedAt = contracts.Null[float64]()
		}
	}
	err = value.Mutate(ctx, func(state *contracts.State) error {
		if conversationID != "" && state.ConversationID != conversationID {
			return ErrMessageConflict
		}
		for _, prior := range state.Messages {
			if prior != nil && prior.ID == message.ID {
				return ErrMessageConflict
			}
		}
		state.Messages = append(state.Messages, &message)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &message, nil
}

func (value *Store) Update(ctx context.Context, id string, patch contracts.MessagePatch) (*contracts.ChatMessage, error) {
	return value.updateMessage(ctx, "", id, patch)
}

// UpdateConversation commits a message patch only within its captured conversation.
func (value *Store) UpdateConversation(ctx context.Context, conversationID, id string, patch contracts.MessagePatch) (*contracts.ChatMessage, error) {
	if conversationID == "" {
		return nil, ErrMessageConflict
	}
	return value.updateMessage(ctx, conversationID, id, patch)
}

func (value *Store) updateMessage(ctx context.Context, conversationID, id string, patch contracts.MessagePatch) (*contracts.ChatMessage, error) {
	for _, key := range []string{"id", "role", "time", "ts"} {
		if _, exists := patch[key]; exists {
			return nil, ErrInvalidState
		}
	}
	var result *contracts.ChatMessage
	err := value.Mutate(ctx, func(state *contracts.State) error {
		if conversationID != "" && state.ConversationID != conversationID {
			return ErrMessageConflict
		}
		message, err := FindMessage(state, id)
		if err != nil {
			return err
		}
		before := make(map[string]bool)
		for _, attachment := range message.Attachments {
			before[attachment.ID] = true
		}
		raw, err := json.Marshal(message)
		if err != nil {
			return ErrInvalidState
		}
		fields, err := contracts.DecodeObject(raw, len(raw))
		if err != nil {
			return ErrInvalidState
		}
		for key, raw := range patch {
			fields[key] = raw
		}
		merged, err := json.Marshal(fields)
		if err != nil {
			return ErrInvalidState
		}
		var updated contracts.ChatMessage
		if json.Unmarshal(merged, &updated) != nil {
			return ErrInvalidState
		}
		if message.Role == contracts.RoleAssistant && message.Read {
			if _, changed := patch["attachments"]; changed {
				for _, attachment := range updated.Attachments {
					if !before[attachment.ID] {
						updated.Read = false
						break
					}
				}
			}
		}
		*message = updated
		result = message
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (value *Store) SetTaskState(ctx context.Context, id string, status contracts.TaskStatus, patch contracts.MessagePatch) (*contracts.ChatMessage, error) {
	if !contracts.ChatTaskStatus(status).Valid() {
		return nil, ErrInvalidState
	}
	patch = cloneMessagePatch(patch)
	raw, _ := json.Marshal(status)
	patch["status"] = raw
	return value.Update(ctx, id, patch)
}

func (value *Store) ConfirmExecution(ctx context.Context, id string, patch contracts.MessagePatch) (*contracts.ChatMessage, error) {
	patch = cloneMessagePatch(patch)
	raw, _ := json.Marshal(value.Timestamp())
	patch["executorConfirmedAt"] = raw
	return value.Update(ctx, id, patch)
}

func cloneMessagePatch(source contracts.MessagePatch) contracts.MessagePatch {
	copy := make(contracts.MessagePatch, len(source)+1)
	for key, value := range source {
		copy[key] = append(json.RawMessage(nil), value...)
	}
	return copy
}

// A nil attachmentSnapshots is the legacy receipt (text/label only). A present
// empty map acknowledges no unseen attachments and cannot consume new files.
func (value *Store) MarkVisible(ctx context.Context, ids []string, attachmentSnapshots map[string][]string) error {
	selected := make(map[string]bool)
	for _, id := range ids {
		selected[id] = true
	}
	now := value.Timestamp()
	return value.Mutate(ctx, func(state *contracts.State) error {
		for _, message := range state.Messages {
			if message == nil || message.Role != contracts.RoleAssistant || !selected[message.ID] {
				continue
			}
			message.VisibleAt = contracts.Some(now)
			if attachmentSnapshots == nil {
				message.Read = true
				continue
			}
			current := make(map[string]bool)
			for _, file := range message.Attachments {
				current[file.ID] = true
			}
			seen := make(map[string]bool)
			for _, id := range message.VisibleAttachmentIDs {
				if current[id] {
					seen[id] = true
				}
			}
			for _, id := range attachmentSnapshots[message.ID] {
				if current[id] {
					seen[id] = true
				}
			}
			message.VisibleAttachmentIDs = []string{}
			complete := true
			for _, file := range message.Attachments {
				if seen[file.ID] {
					message.VisibleAttachmentIDs = append(message.VisibleAttachmentIDs, file.ID)
				} else {
					complete = false
				}
			}
			message.Read = message.Read || complete
		}
		for index := range state.Completions {
			completion := &state.Completions[index]
			complete := len(completion.MessageIDs) > 0
			for _, id := range completion.MessageIDs {
				message, err := FindMessage(state, id)
				if err != nil || !message.Read {
					complete = false
					break
				}
			}
			if complete && (!completion.ReadAt.Present || completion.ReadAt.Null || completion.ReadAt.Value == 0) {
				completion.ReadAt = contracts.Some(now)
			}
		}
		return nil
	})
}

func (value *Store) MaterializeScheduledMessage(ctx context.Context, input *contracts.ChatMessage, recovered bool) (*contracts.ChatMessage, error) {
	if input == nil || input.ID == "" || input.ScheduleID == "" || !input.Scheduled || !input.ScheduledAt.Present || input.ScheduledAt.Null || !validTimestamp(input.ScheduledAt.Value) || input.Role != contracts.RoleUser {
		return nil, ErrInvalidState
	}
	var result *contracts.ChatMessage
	err := value.Mutate(ctx, func(state *contracts.State) error {
		var existing *contracts.ChatMessage
		for _, message := range state.Messages {
			if message != nil && message.ID == input.ID {
				if existing != nil {
					return ErrMessageConflict
				}
				existing = message
			}
		}
		if existing != nil {
			if existing.Role != input.Role || !existing.Scheduled || existing.ScheduleID != input.ScheduleID || existing.ScheduledAt != input.ScheduledAt || existing.Text != input.Text {
				return ErrMessageConflict
			}
			result = existing
		} else {
			raw, err := json.Marshal(input)
			if err != nil {
				return ErrInvalidState
			}
			var saved contracts.ChatMessage
			if json.Unmarshal(raw, &saved) != nil {
				return ErrInvalidState
			}
			if !saved.Time.Present {
				saved.Time = contracts.Some(value.Timestamp())
			}
			if !saved.ReceivedAt.Present {
				saved.ReceivedAt = contracts.Some(value.Timestamp())
			}
			if !saved.ExecutorConfirmedAt.Present {
				saved.ExecutorConfirmedAt = contracts.Null[float64]()
			}
			if saved.Reactions == nil {
				saved.Reactions = []string{}
			}
			state.Messages = append(state.Messages, &saved)
			result = &saved
		}
		if recovered && result.Status.Value == contracts.MessageStatus(contracts.TaskStatusQueued) && !result.UnknownOutcome && (!result.TurnID.Present || result.TurnID.Null || result.TurnID.Value == "") && (!result.ExecutorConfirmedAt.Present || result.ExecutorConfirmedAt.Null) && (!result.Submission.Present || result.Submission.Null || result.Submission.Value == contracts.SubmissionStatusNotSubmitted) {
			result.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			result.PauseReason = contracts.Some("schedule-recovery")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (value *Store) HasDeletedClientID(id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	for _, prior := range value.Snapshot().DeletedClientMessageIDs {
		if prior == id {
			return true
		}
	}
	return false
}
