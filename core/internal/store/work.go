package store

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const MaxWorkRecords = 300

func workError(code, message string) error {
	return &contracts.APIError{Status: 409, Code: code, Message: message}
}

func continuationConflict() error {
	return workError("continuation_conflict", "The saved task continuation changed or is unconfirmed.")
}

func FindWork(state *contracts.State, id string) (*contracts.WorkRecord, error) {
	var result *contracts.WorkRecord
	for index := range state.WorkTasks {
		if state.WorkTasks[index].ID == id {
			if result != nil {
				return nil, ErrMessageConflict
			}
			result = &state.WorkTasks[index]
		}
	}
	if result == nil {
		return nil, workError("work_not_found", "The task was not found.")
	}
	return result, nil
}

type RegisterWorkOptions struct {
	WorkID    string
	TurnID    string
	MessageID string
	Source    string
	Title     string
	Plan      *contracts.TaskPlan
	StartedAt float64
	Status    contracts.WorkStatus
	Observed  bool
}

func uniqueStrings(values ...[]string) []string {
	result := []string{}
	for _, list := range values {
		for _, value := range list {
			if !slices.Contains(result, value) {
				result = append(result, value)
			}
		}
	}
	return result
}

func (value *Store) RegisterWork(ctx context.Context, input RegisterWorkOptions) (*contracts.WorkRecord, error) {
	if !workstate.ValidID(input.TurnID, workstate.ReferenceIDLength) || (input.Source != "chat" && input.Source != "voice") {
		return nil, workError("work_stale_turn", "Registered work requires an owned turn.")
	}
	withoutPlan := input.Observed && input.Plan == nil
	title := input.Title
	var legacyTitle contracts.LegacyJSON
	var plan *contracts.TaskPlan
	if withoutPlan {
		title = contracts.TrimText(title)
		if title == "" || contracts.UTF16Length(title) > workstate.PlanTitleLength {
			return nil, workstate.ErrInvalidPlan
		}
	} else {
		if input.Plan == nil {
			return nil, workstate.ErrInvalidPlan
		}
		rawTitle, _ := json.Marshal(title)
		rawSteps, _ := json.Marshal(input.Plan.Steps)
		safe, err := workstate.ReadPlanInput(contracts.RawObject{"title": rawTitle, "steps": rawSteps}, nil)
		if err != nil {
			return nil, err
		}
		title = safe.Title
		legacyTitle = safe.LegacyTitle
		plan = &safe.Plan
	}
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		current, index := -1, -1
		for position := range state.WorkTasks {
			entry := &state.WorkTasks[position]
			if entry.TurnID == input.TurnID {
				current = position
			}
			if input.WorkID != "" && entry.ID == input.WorkID {
				index = position
			}
		}
		if input.WorkID == "" {
			index = current
		} else if index < 0 {
			return workError("work_not_found", "The task to continue was not found.")
		}
		var previous *contracts.WorkRecord
		if index >= 0 {
			previous = &state.WorkTasks[index]
		}
		if previous != nil {
			if previous.Status == contracts.WorkStatusCancelled {
				return workError("work_not_continuable", "Cancelled work requires an explicit new human reply.")
			}
			if workstate.Unconfirmed(previous) || (previous.Continuation != nil && previous.Continuation.Dispatch != nil && (previous.TurnID != input.TurnID || previous.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseAcknowledged)) {
				return continuationConflict()
			}
		}
		supersede := false
		if current >= 0 && index != current {
			automatic := &state.WorkTasks[current]
			supersede = !input.Observed && automatic.Provisional && (automatic.Status == contracts.WorkStatusRunning || automatic.Status == contracts.WorkStatusWaitingUser) && len(automatic.TurnIDs) == 1 && automatic.TurnIDs[0] == input.TurnID && (automatic.Continuation == nil || automatic.Continuation.Dispatch == nil)
			if !supersede {
				return workError("work_conflict", "This turn already belongs to a different task.")
			}
		}
		if previous != nil && previous.TurnID != input.TurnID {
			switch previous.Status {
			case contracts.WorkStatusContinuing, contracts.WorkStatusWaitingUser, contracts.WorkStatusPaused, contracts.WorkStatusReview:
			default:
				return workError("work_not_continuable", "Only inactive unfinished work can continue in another turn.")
			}
			if slices.Contains(previous.TurnIDs, input.TurnID) {
				return workError("work_stale_turn", "A previous task turn cannot replace its current turn.")
			}
		}
		if previous == nil {
			for _, entry := range state.WorkTasks {
				if slices.Contains(entry.TurnIDs, input.TurnID) {
					return workError("work_stale_turn", "This turn already belongs to another task.")
				}
			}
		}
		now := value.Timestamp()
		record := contracts.WorkRecord{ID: value.newID(), Source: input.Source, StartedAt: now, MessageID: contracts.Null[string](), TurnIDs: []string{}}
		if workstate.ValidTime(input.StartedAt) {
			record.StartedAt = input.StartedAt
		}
		if previous != nil {
			record = *previous
		} else if input.MessageID != "" {
			for _, message := range state.Messages {
				if message.ID == input.MessageID && message.Role == contracts.RoleUser {
					record.ProgressPriority = message.ProgressPriority
				}
			}
		}
		if previous != nil && withoutPlan && previous.Plan != nil {
			title = previous.Title
			plan = previous.Plan
		}
		priorTurn := record.TurnID
		record.TurnIDs = uniqueStrings(record.TurnIDs, []string{priorTurn, input.TurnID})
		if len(record.TurnIDs) > 0 && record.TurnIDs[0] == "" {
			record.TurnIDs = record.TurnIDs[1:]
		}
		record.TurnID = input.TurnID
		record.Title = title
		if legacyTitle.Original != nil {
			record.LegacyText = legacyTitle
		}
		record.Plan = plan
		record.Status = input.Status
		switch record.Status {
		case contracts.WorkStatusRunning, contracts.WorkStatusWaitingUser, contracts.WorkStatusPausing, contracts.WorkStatusUnknown:
		default:
			record.Status = contracts.WorkStatusRunning
		}
		if record.MessageID.Value == "" && input.MessageID != "" {
			record.MessageID = contracts.Some(input.MessageID)
		}
		record.Provisional = withoutPlan && (record.Plan == nil) || input.Observed && record.Provisional
		if previous != nil && priorTurn != input.TurnID && (previous.Continuation == nil || previous.Continuation.Dispatch == nil) {
			record.Continuation = nil
		}
		record.UpdatedAt = now
		record.ProgressDismissedAt = contracts.Optional[float64]{}
		record.PauseReason = contracts.Optional[string]{}
		record.ExecutionEndedAt = contracts.Optional[float64]{}
		if index < 0 {
			state.WorkTasks = append(state.WorkTasks, record)
			index = len(state.WorkTasks) - 1
		} else {
			state.WorkTasks[index] = record
		}
		if supersede {
			state.WorkTasks = append(state.WorkTasks[:current], state.WorkTasks[current+1:]...)
			if current < index {
				index--
			}
		}
		if len(state.WorkTasks) > MaxWorkRecords {
			drop := len(state.WorkTasks) - MaxWorkRecords
			state.WorkTasks = state.WorkTasks[drop:]
			index -= drop
		}
		result = &state.WorkTasks[index]
		return nil
	})
	return result, err
}

type UpdateRegisteredWorkOptions struct {
	Status            contracts.Optional[contracts.WorkStatus]
	Plan              *contracts.TaskPlan
	ExecutionEnded    bool
	ExecutionObserved bool
	At                float64
}

func (value *Store) UpdateRegisteredWork(ctx context.Context, turnID string, input UpdateRegisteredWorkOptions) (*contracts.WorkRecord, error) {
	if input.At == 0 {
		input.At = value.Timestamp()
	}
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		var record *contracts.WorkRecord
		for index := range state.WorkTasks {
			if state.WorkTasks[index].TurnID == turnID {
				record = &state.WorkTasks[index]
				break
			}
		}
		if record == nil {
			return ErrNoChange
		}
		c := record.Continuation
		if c != nil && (c.Invalid || c.Dispatch != nil && c.Dispatch.Phase != contracts.ContinuationDispatchPhaseAcknowledged) {
			return continuationConflict()
		}
		if record.Status == contracts.WorkStatusCancelled && (input.Plan != nil || input.Status.Present && input.Status.Value != contracts.WorkStatusCancelled) {
			return workError("work_not_continuable", "Cancelled work cannot be changed by an earlier execution.")
		}
		if input.Status.Present {
			if input.Status.Null || !input.Status.Value.Valid() {
				return ErrInvalidState
			}
			record.Status = input.Status.Value
		}
		if input.Plan != nil {
			safe, err := workstate.PublicPlan(input.Plan.Steps, nil)
			if err != nil {
				return err
			}
			record.Plan = &safe
		}
		if input.ExecutionEnded {
			if !workstate.ValidTime(input.At) {
				return ErrInvalidState
			}
			record.ExecutionEndedAt = contracts.Some(input.At)
		}
		record.UpdatedAt = input.At
		if input.ExecutionEnded && c != nil && c.Dispatch != nil {
			if c.Dispatch.TurnID != turnID || !workstate.SafeContinuation(c) {
				return continuationConflict()
			}
			switch record.Status {
			case contracts.WorkStatusContinuing, contracts.WorkStatusWaitingUser, contracts.WorkStatusPaused, contracts.WorkStatusFailed, contracts.WorkStatusReview, contracts.WorkStatusCompleted, contracts.WorkStatusCancelled:
			default:
				return continuationConflict()
			}
			checkpoint := workstate.Checkpoint(record.Plan)
			count := 0
			if !input.ExecutionObserved && checkpoint == c.LastCheckpoint {
				count = c.NoProgressCount + 1
			}
			record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), Attempts: c.Attempts, NoProgressCount: count, LastCheckpoint: checkpoint}
			if record.Status == contracts.WorkStatusContinuing {
				record.Continuation.NextAt = contracts.Some(min(float64(workstate.MaxTimestamp), input.At+workstate.Delay(count)))
				if count >= workstate.NoProgressLimit {
					record.Status = contracts.WorkStatusPaused
					record.PauseReason = contracts.Some("automatic-no-progress")
					record.Continuation.NextAt = contracts.Null[float64]()
				}
			}
		}
		result = record
		return nil
	})
	return result, err
}

func (value *Store) AddCompletion(ctx context.Context, turnID string, messageIDs []string, taskID contracts.Optional[string], work contracts.RawObject) (*contracts.Completion, error) {
	var result *contracts.Completion
	err := value.Mutate(ctx, func(state *contracts.State) error {
		for index := range state.Completions {
			if state.Completions[index].TurnID == turnID {
				result = &state.Completions[index]
				return ErrNoChange
			}
		}
		completion := contracts.Completion{ID: value.newID(), TurnID: turnID, MessageIDs: append([]string(nil), messageIDs...), TaskID: taskID, At: contracts.Some(value.Timestamp()), ReadAt: contracts.Null[float64](), Work: work}
		state.Completions = append(state.Completions, completion)
		if len(state.Completions) > MaxWorkRecords {
			state.Completions = state.Completions[len(state.Completions)-MaxWorkRecords:]
		}
		result = &state.Completions[len(state.Completions)-1]
		return nil
	})
	return result, err
}

func (value *Store) Confirm(ctx context.Context, id string) (*contracts.ChatMessage, error) {
	var result *contracts.ChatMessage
	err := value.Mutate(ctx, func(state *contracts.State) error {
		message, err := FindMessage(state, id)
		if err != nil {
			return err
		}
		if message.Role != contracts.RoleUser || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) {
			return workError("not_reviewable", "Only a task awaiting review can be accepted.")
		}
		for index := range state.WorkTasks {
			record := &state.WorkTasks[index]
			if (record.TurnID == message.TurnID.Value || record.ID == message.WorkID || record.MessageID.Value == message.ID) && record.Continuation != nil && (workstate.Unconfirmed(record) || record.Continuation.Dispatch != nil) {
				return continuationConflict()
			}
		}
		now := value.Timestamp()
		message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))
		message.AcceptedAt = contracts.Some(now)
		for index := range state.WorkTasks {
			record := &state.WorkTasks[index]
			if record.TurnID == message.TurnID.Value {
				record.Status = contracts.WorkStatusCompleted
				record.UpdatedAt = now
			}
		}
		result = message
		return nil
	})
	return result, err
}
