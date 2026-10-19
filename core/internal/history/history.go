// Package history manages visible chat history without rewriting executor
// conversation identity, granting tool permissions or replaying tasks.
package history

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const (
	MessageIDLimit       = 128
	DeletedClientIDLimit = 2000
)
const ecmaWhitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

type Persistence interface {
	Snapshot() contracts.State
	Mutate(
		context.Context,
		func(*contracts.State) error) error
	Timestamp() float64
}
type Ownership struct {
	Call              bool
	ActiveIDs         []string
	Finishing         bool
	PendingFollowups  int
	CallReferences    int
	NativeVoiceActive bool
	VoiceTaskIDs      []string
	Queue             []string
}
type QueueChange struct {
	EnqueueID  string
	WithdrawID string
	Clear      bool
}

// Admission is implemented by the Engine owner goroutine. The queue change is
// applied only if the callback's Store transaction commits successfully.
type Admission func(
	context.Context,
	func(Ownership) (QueueChange, error)) error
type History struct {
	store Persistence
	admit Admission
}

func New(persistence Persistence, admission Admission) *History {
	return &History{store: persistence, admit: admission}
}

func fail(status int, code, message string) error {
	return &contracts.APIError{Status: status, Code: code, Message: message}
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func idle(owner Ownership) error {
	if owner.Call {
		return fail(409, "history_call_active", "End the voice call before changing history")
	}
	if len(owner.ActiveIDs) > 0 || owner.Finishing || owner.PendingFollowups > 0 || owner.CallReferences > 0 || owner.NativeVoiceActive {
		return fail(409, "history_work_active", "Stop active work before changing history")
	}
	return nil
}

func message(state *contracts.State, id string) (*contracts.ChatMessage, error) {
	if id == "" || len(id) > MessageIDLimit {
		return nil, fail(400, "invalid_message_id", "Invalid message ID")
	}
	found, err := store.FindMessage(state, id)
	if err == store.ErrMessageConflict {
		return nil, fail(409, "message_identity_conflict", "The message identity is ambiguous")
	}
	if err != nil {
		return nil, fail(404, "message_not_found", "Message not found")
	}
	return found, nil
}

type BookmarkMessage struct {
	ID      string `json:"id"`
	Pinned  bool   `json:"pinned"`
	Starred bool   `json:"starred"`
}
type BookmarkReceipt struct {
	ConversationID string          `json:"conversationId"`
	Message        BookmarkMessage `json:"message"`
}

func (value *History) SetMetadata(ctx context.Context, id string, input contracts.RawObject) (BookmarkReceipt, error) {
	var receipt BookmarkReceipt
	for key := range input {
		if key != "conversationId" && key != "pinned" && key != "starred" {
			return receipt, fail(400, "invalid_message_metadata", "Invalid message metadata")
		}
	}
	var conversation string
	if !contracts.ValidUnicodeJSON(input["conversationId"]) || json.Unmarshal(input["conversationId"], &conversation) != nil || conversation == "" || len(conversation) > MessageIDLimit {
		return receipt, fail(400, "invalid_message_metadata", "Invalid message metadata")
	}
	patch := make(map[string]bool)
	for _, key := range []string{"pinned", "starred"} {
		if raw, exists := input[key]; exists {
			var flag bool
			if strings.TrimSpace(string(raw)) == "null" || json.Unmarshal(raw, &flag) != nil {
				return receipt, fail(400, "invalid_message_metadata", "Invalid message metadata")
			}
			patch[key] = flag
		}
	}
	if len(patch) == 0 {
		return receipt, fail(400, "empty_message_metadata", "Message metadata is empty")
	}
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversation {
			return fail(409, "conversation_changed", "The conversation changed before the message could be updated")
		}
		target, err := message(state, id)
		if err != nil {
			return err
		}
		if target.Role != contracts.RoleUser && target.Role != contracts.RoleAssistant {
			return fail(400, "invalid_bookmark_message", "Only visible chat messages support bookmarks")
		}
		changed := false
		if flag, present := patch["pinned"]; present {
			changed = changed || !target.Pinned.Present || target.Pinned.Null || target.Pinned.Value != flag
			target.Pinned = contracts.Some(flag)
		}
		if flag, present := patch["starred"]; present {
			changed = changed || !target.Starred.Present || target.Starred.Null || target.Starred.Value != flag
			target.Starred = contracts.Some(flag)
		}
		receipt = BookmarkReceipt{ConversationID: conversation, Message: BookmarkMessage{ID: target.ID, Pinned: target.Pinned.Value, Starred: target.Starred.Value}}
		if !changed {
			return store.ErrNoChange
		}
		return nil
	})
	return receipt, err
}

type EditReceipt struct {
	Edited      bool                   `json:"edited"`
	Message     *contracts.ChatMessage `json:"message"`
	Resubmitted bool                   `json:"resubmitted"`
}

func (value *History) Edit(ctx context.Context, id, text string, resubmit bool) (EditReceipt, error) {
	var receipt EditReceipt
	text = strings.Trim(text, ecmaWhitespace)
	if text == "" {
		return receipt, fail(400, "invalid_message_text", "Message text must be non-empty")
	}
	if value.admit == nil {
		return receipt, fail(409, "history_unavailable", "History editing is unavailable")
	}
	err := value.admit(ctx, func(owner Ownership) (QueueChange, error) {
		if err := idle(owner); err != nil {
			return QueueChange{}, err
		}
		var change QueueChange
		err := value.store.Mutate(ctx, func(state *contracts.State) error {
			target, err := message(state, id)
			if err != nil {
				return err
			}
			if target.Role != contracts.RoleUser {
				return fail(400, "invalid_edit_role", "Only user message text can be edited")
			}
			target.Text = text
			target.ClearLegacyText("text")
			target.EditedAt = contracts.Some(value.store.Timestamp())
			if resubmit {
				status := contracts.TaskStatusDraft
				if contains(owner.Queue, id) {
					status = contracts.TaskStatusQueued
				}
				target.Status = contracts.Some(contracts.MessageStatus(status))
				target.Submission = contracts.Null[contracts.SubmissionStatus]()
				target.TurnID = contracts.Null[string]()
				target.ExecutorConfirmedAt = contracts.Null[float64]()
				target.Error = contracts.Null[string]()
				target.AcceptedAt = contracts.Null[float64]()
				target.ParentTaskID = contracts.Null[string]()
				target.PauseReason = contracts.Null[string]()
				change.EnqueueID = id
			}
			receipt = EditReceipt{Edited: true, Message: target, Resubmitted: resubmit}
			return nil
		})
		return change, err
	})
	return receipt, err
}

func deletedClientIDs(previous []string, messages []*contracts.ChatMessage) []string {
	additions := make([]string, 0)
	for _, message := range messages {
		if message != nil && message.Role == contracts.RoleUser && message.ClientMessageID != "" && len(message.ClientMessageID) <= MessageIDLimit && !contains(additions, message.ClientMessageID) {
			additions = append(additions, message.ClientMessageID)
		}
	}
	result := make([]string, 0, len(previous)+len(additions))
	for _, id := range previous {
		if !contains(additions, id) && !contains(result, id) {
			result = append(result, id)
		}
	}
	result = append(result, additions...)
	if len(result) > DeletedClientIDLimit {
		result = result[len(result)-DeletedClientIDLimit:]
	}
	return result
}

type RemoveReceipt struct {
	Removed   bool   `json:"removed"`
	ID        string `json:"id"`
	Withdrawn bool   `json:"withdrawn"`
}

func (value *History) Remove(ctx context.Context, id string) (RemoveReceipt, error) {
	var receipt RemoveReceipt
	if value.admit == nil {
		return receipt, fail(409, "history_unavailable", "History editing is unavailable")
	}
	err := value.admit(ctx, func(owner Ownership) (QueueChange, error) {
		if owner.Call {
			return QueueChange{}, fail(409, "history_call_active", "End the voice call before changing history")
		}
		err := value.store.Mutate(ctx, func(state *contracts.State) error {
			target, err := message(state, id)
			if err != nil {
				return err
			}
			withdrawn := target.Role == contracts.RoleUser && !contains(owner.ActiveIDs, id) && !contains(owner.VoiceTaskIDs, id) && contains(owner.Queue, id)
			if !withdrawn {
				if err := idle(owner); err != nil {
					return err
				}
			}
			kept := make([]*contracts.ChatMessage, 0, len(state.Messages))
			for _, entry := range state.Messages {
				if entry.ID == id {
					continue
				}
				if entry.ReplyTo.Value == id {
					entry.ReplyTo = contracts.Null[string]()
				}
				kept = append(kept, entry)
			}
			completions := make([]contracts.Completion, 0, len(state.Completions))
			for _, entry := range state.Completions {
				ids := make([]string, 0, len(entry.MessageIDs))
				for _, prior := range entry.MessageIDs {
					if prior != id {
						ids = append(ids, prior)
					}
				}
				entry.MessageIDs = ids
				if entry.TaskID.Value == id {
					entry.TaskID = contracts.Null[string]()
				}
				if len(ids) > 0 {
					completions = append(completions, entry)
				}
			}
			state.Messages = kept
			state.Completions = completions
			state.DeletedClientMessageIDs = deletedClientIDs(state.DeletedClientMessageIDs, []*contracts.ChatMessage{target})
			receipt = RemoveReceipt{Removed: true, ID: id, Withdrawn: withdrawn}
			return nil
		})
		return QueueChange{WithdrawID: id}, err
	})
	return receipt, err
}

type ClearReceipt struct {
	Cleared bool `json:"cleared"`
	Count   int  `json:"count"`
}

func (value *History) Clear(ctx context.Context, confirm bool) (ClearReceipt, error) {
	var receipt ClearReceipt
	if !confirm {
		return receipt, fail(400, "confirm_history_clear", "Confirm clearing the visible history")
	}
	if value.admit == nil {
		return receipt, fail(409, "history_unavailable", "History editing is unavailable")
	}
	err := value.admit(ctx, func(owner Ownership) (QueueChange, error) {
		if err := idle(owner); err != nil {
			return QueueChange{}, err
		}
		if len(owner.VoiceTaskIDs) > 0 {
			return QueueChange{}, fail(409, "history_work_active", "Stop active work before changing history")
		}
		err := value.store.Mutate(ctx, func(state *contracts.State) error {
			receipt = ClearReceipt{Cleared: true, Count: len(state.Messages)}
			state.DeletedClientMessageIDs = deletedClientIDs(state.DeletedClientMessageIDs, state.Messages)
			state.Messages = []*contracts.ChatMessage{}
			state.Completions = []contracts.Completion{}
			return nil
		})
		return QueueChange{Clear: true}, err
	})
	return receipt, err
}
