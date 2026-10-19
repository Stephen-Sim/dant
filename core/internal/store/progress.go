package store

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type ProgressKind string

const (
	ProgressTask       ProgressKind = "task"
	ProgressWork       ProgressKind = "work"
	ProgressCompletion ProgressKind = "completion"
)

func (kind ProgressKind) Valid() bool {
	return kind == ProgressTask || kind == ProgressWork || kind == ProgressCompletion
}

type ProgressCandidate struct {
	ID   string       `json:"id"`
	Kind ProgressKind `json:"kind"`
}
type DismissOptions struct {
	ConfirmUnfinished      bool
	ExpectedTurnID         contracts.Optional[string]
	ExpectedConversationID contracts.Optional[string]
}
type ProgressError struct {
	*contracts.APIError
	ConfirmationRequired bool
}

func (value *ProgressError) Unwrap() error {
	return value.APIError
}

func (value *ProgressError) ConfirmationNeeded() bool { return value.ConfirmationRequired }

type progressEntry struct {
	message    *contracts.ChatMessage
	work       *contracts.WorkRecord
	completion *contracts.Completion
}

func progressFailure(status int, message string) error {
	return &contracts.APIError{Status: status, Code: "work_progress_conflict", Message: message}
}

func completionWork(completion *contracts.Completion) bool {
	if completion == nil || strings.Contains(completion.TurnID, ":input:") || strings.Contains(completion.TurnID, ":credential:") {
		return false
	}
	var source, status string
	if json.Unmarshal(completion.Work["source"], &source) != nil || source != "voice" || json.Unmarshal(completion.Work["status"], &status) != nil {
		return false
	}
	switch contracts.TaskStatus(status) {
	case contracts.TaskStatusReview, contracts.TaskStatusFailed, contracts.TaskStatusPaused, contracts.TaskStatusCancelled:
		return true
	}
	return false
}

func selectProgress(state *contracts.State, id string, kind ProgressKind) (progressEntry, error) {
	if !kind.Valid() || !workstate.ValidID(id, workstate.IDLength) {
		return progressEntry{}, progressFailure(400, "Invalid work progress request.")
	}
	var selected progressEntry
	switch kind {
	case ProgressTask:
		message, err := FindMessage(state, id)
		if err != nil {
			return selected, progressFailure(404, "Work progress entry not found.")
		}
		if message.Role != contracts.RoleUser {
			return selected, progressFailure(409, "Only user task progress can be changed.")
		}
		selected.message = message
	case ProgressWork:
		record, err := FindWork(state, id)
		if err != nil {
			return selected, progressFailure(404, "Work progress entry not found.")
		}
		selected.work = record
	case ProgressCompletion:
		for index := range state.Completions {
			if state.Completions[index].ID == id {
				if selected.completion != nil {
					return progressEntry{}, progressFailure(409, "Ambiguous work progress identity.")
				}
				selected.completion = &state.Completions[index]
			}
		}
		if selected.completion == nil {
			return selected, progressFailure(404, "Work progress entry not found.")
		}
		if !completionWork(selected.completion) {
			return progressEntry{}, progressFailure(409, "Only final voice task history can be dismissed.")
		}
		visible := false
		for _, message := range state.Messages {
			visible = visible || message.Role == contracts.RoleAssistant && message.Status.Value != contracts.MessageStatusStreaming && slices.Contains(selected.completion.MessageIDs, message.ID)
		}
		if !visible {
			return progressEntry{}, progressFailure(409, "Only final voice task history can be dismissed.")
		}
	}
	return selected, nil
}

func (entry progressEntry) turnID() string {
	if entry.message != nil {
		return entry.message.TurnID.Value
	}
	if entry.work != nil {
		return entry.work.TurnID
	}
	return entry.completion.TurnID
}

func (entry progressEntry) status() contracts.TaskStatus {
	if entry.message != nil {
		return contracts.TaskStatus(entry.message.Status.Value)
	}
	if entry.work != nil {
		return contracts.TaskStatus(entry.work.Status)
	}
	return ""
}

func (entry progressEntry) dismissed() *contracts.Optional[float64] {
	if entry.message != nil {
		return &entry.message.ProgressDismissedAt
	}
	if entry.work != nil {
		return &entry.work.ProgressDismissedAt
	}
	return &entry.completion.ProgressDismissedAt
}

func (entry progressEntry) priority() *contracts.Optional[contracts.TaskPriority] {
	if entry.message != nil {
		return &entry.message.ProgressPriority
	}
	if entry.work != nil {
		return &entry.work.ProgressPriority
	}
	return &entry.completion.ProgressPriority
}

func (entry progressEntry) unconfirmed() bool {
	if entry.message != nil {
		return entry.message.UnknownOutcome || entry.message.Submission.Value == contracts.SubmissionStatusUnknown || entry.message.Submission.Value == contracts.SubmissionStatusSubmitting || entry.message.Continuation != nil && (!workstate.SafeContinuation(entry.message.Continuation) || entry.message.Continuation.Dispatch != nil)
	}
	if entry.work != nil {
		return entry.work.UnknownOutcome || entry.work.Submission.Value == contracts.SubmissionStatusUnknown || entry.work.Submission.Value == contracts.SubmissionStatusSubmitting || workstate.Unconfirmed(entry.work) || entry.work.Continuation != nil && entry.work.Continuation.Dispatch != nil
	}
	return false
}

func completedProgress(state *contracts.State, entry progressEntry) bool {
	if entry.unconfirmed() {
		return false
	}
	turn := entry.turnID()
	if entry.message != nil {
		if entry.message.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) {
			return false
		}
		for index := range state.WorkTasks {
			record := &state.WorkTasks[index]
			if (record.TurnID == turn || record.ID == entry.message.WorkID || record.MessageID.Value == entry.message.ID) && (workstate.Unconfirmed(record) || record.Continuation != nil && record.Continuation.Dispatch != nil) {
				return false
			}
		}
		return true
	}
	related := []*contracts.ChatMessage{}
	for _, message := range state.Messages {
		if message.Role == contracts.RoleUser && (turn != "" && message.TurnID.Value == turn || entry.completion != nil && message.ID == entry.completion.TaskID.Value) {
			if (progressEntry{message: message}).unconfirmed() {
				return false
			}
			related = append(related, message)
		}
	}
	if entry.work != nil {
		return entry.work.Status == contracts.WorkStatusCompleted
	}
	foundRecord := false
	currentCompleted := false
	for _, record := range state.WorkTasks {
		if record.TurnID == turn || turn != "" && slices.Contains(record.TurnIDs, turn) {
			foundRecord = true
			currentCompleted = currentCompleted || record.TurnID == turn && record.Status == contracts.WorkStatusCompleted
		}
	}
	if foundRecord {
		return currentCompleted
	}
	for _, message := range related {
		if message.TurnID.Value == turn && message.Status.Value == contracts.MessageStatus(contracts.TaskStatusCompleted) && (entry.completion.TaskID.Value == "" || message.ID == entry.completion.TaskID.Value) {
			return true
		}
	}
	return false
}

func (value *Store) ProgressRecord(id string, kind ProgressKind) (json.RawMessage, error) {
	state := value.Snapshot()
	entry, err := selectProgress(&state, id, kind)
	if err != nil {
		return nil, err
	}
	if entry.message != nil {
		return json.Marshal(entry.message)
	}
	if entry.work != nil {
		return json.Marshal(entry.work)
	}
	return json.Marshal(entry.completion)
}

func (value *Store) SetProgressPriority(ctx context.Context, id string, kind ProgressKind, priority contracts.TaskPriority) error {
	if !priority.Valid() {
		return progressFailure(400, "Invalid work progress priority.")
	}
	return value.Mutate(ctx, func(state *contracts.State) error {
		entry, err := selectProgress(state, id, kind)
		if err != nil {
			return err
		}
		field := entry.priority()
		if field.Present && !field.Null && field.Value == priority {
			return ErrNoChange
		}
		*field = contracts.Some(priority)
		return nil
	})
}

func (value *Store) DismissProgress(ctx context.Context, id string, kind ProgressKind, options DismissOptions) error {
	if options.ExpectedTurnID.Present && !options.ExpectedTurnID.Null && !workstate.ValidID(options.ExpectedTurnID.Value, workstate.ReferenceIDLength) || options.ExpectedConversationID.Present && (options.ExpectedConversationID.Null || !workstate.ValidID(options.ExpectedConversationID.Value, workstate.IDLength)) {
		return progressFailure(400, "Invalid work progress identity.")
	}
	return value.Mutate(ctx, func(state *contracts.State) error {
		entry, err := selectProgress(state, id, kind)
		if err != nil {
			return err
		}
		if options.ExpectedTurnID.Present && (options.ExpectedTurnID.Null && entry.turnID() != "" || !options.ExpectedTurnID.Null && entry.turnID() != options.ExpectedTurnID.Value) || options.ExpectedConversationID.Present && state.ConversationID != options.ExpectedConversationID.Value {
			return progressFailure(409, "The work progress identity changed.")
		}
		if kind != ProgressCompletion {
			switch entry.status() {
			case contracts.TaskStatusCompleted, contracts.TaskStatusCancelled, contracts.TaskStatusFailed, contracts.TaskStatusReview, contracts.TaskStatusPaused, contracts.TaskStatus(contracts.WorkStatusContinuing):
			default:
				return progressFailure(409, "Only inactive task history can be dismissed.")
			}
		}
		if !completedProgress(state, entry) && !options.ConfirmUnfinished {
			return &ProgressError{APIError: &contracts.APIError{Status: 409, Code: "confirmation_required", Message: "Confirm before hiding unfinished work."}, ConfirmationRequired: true}
		}
		if entry.dismissed().Value > 0 {
			return ErrNoChange
		}
		*entry.dismissed() = contracts.Some(value.Timestamp())
		return nil
	})
}

func (value *Store) ClearCompletedProgress(ctx context.Context, candidates []ProgressCandidate) (int, error) {
	cleared := 0
	err := value.Mutate(ctx, func(state *contracts.State) error {
		for _, candidate := range candidates {
			entry, err := selectProgress(state, candidate.ID, candidate.Kind)
			if err != nil || entry.dismissed().Value > 0 || !completedProgress(state, entry) {
				continue
			}
			*entry.dismissed() = contracts.Some(value.Timestamp())
			cleared++
		}
		if cleared == 0 {
			return ErrNoChange
		}
		return nil
	})
	return cleared, err
}

func (value *Store) RestoreWorkProgress(ctx context.Context, messageID string) error {
	return value.Mutate(ctx, func(state *contracts.State) error {
		for index := len(state.WorkTasks) - 1; index >= 0; index-- {
			record := &state.WorkTasks[index]
			if record.MessageID.Value == messageID {
				if record.ProgressDismissedAt.Value == 0 {
					return ErrNoChange
				}
				record.ProgressDismissedAt = contracts.Optional[float64]{}
				return nil
			}
		}
		return ErrNoChange
	})
}

func (value *Store) ResumeWork(ctx context.Context, workID, turnID string) (*contracts.WorkRecord, error) {
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, err := FindWork(state, workID)
		if err != nil || record.TurnID != turnID || record.Status != contracts.WorkStatusPaused || !workstate.ValidTime(record.ExecutionEndedAt.Value) || (progressEntry{work: record}).unconfirmed() || !workstate.Unfinished(record) {
			return progressFailure(409, "This task cannot be resumed safely.")
		}
		for _, message := range state.Messages {
			if message.Role == contracts.RoleUser && (message.TurnID.Value == turnID || message.WorkID == workID) && (progressEntry{message: message}).unconfirmed() {
				return progressFailure(409, "This task cannot be resumed safely.")
			}
		}
		now := value.Timestamp()
		attempts := 0
		if record.Continuation != nil {
			attempts = record.Continuation.Attempts
		}
		record.Status = contracts.WorkStatusContinuing
		record.UpdatedAt = now
		record.PauseReason = contracts.Null[string]()
		record.ProgressDismissedAt = contracts.Optional[float64]{}
		record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(now), Attempts: attempts, LastCheckpoint: workstate.Checkpoint(record.Plan)}
		result = record
		return nil
	})
	return result, err
}
