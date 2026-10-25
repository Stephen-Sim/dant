package store

import (
	"context"
	"regexp"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type ClaimContinuationOptions struct {
	ExpectedTurnID, AttemptID, RuntimeID, ThreadID string
	At                                             float64
	HumanReply                                     bool
}

func (value *Store) ClaimWorkContinuation(ctx context.Context, workID string, input ClaimContinuationOptions) (*contracts.WorkRecord, error) {
	return value.claimWorkContinuation(ctx, workID, input, "")
}

// ClaimPausedWorkContinuation admits one explicit, known paused selection. Its
// identity and claim are committed together, without an unowned Continuing gap.
func (value *Store) ClaimPausedWorkContinuation(ctx context.Context, conversationID, workID string, input ClaimContinuationOptions) (*contracts.WorkRecord, error) {
	if conversationID == "" || input.HumanReply {
		return nil, continuationConflict()
	}
	return value.claimWorkContinuation(ctx, workID, input, conversationID)
}

func (value *Store) claimWorkContinuation(ctx context.Context, workID string, input ClaimContinuationOptions, selectedConversation string) (*contracts.WorkRecord, error) {
	if input.At == 0 {
		input.At = value.Timestamp()
	}
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, err := FindWork(state, workID)
		if err != nil {
			return continuationConflict()
		}
		if selectedConversation != "" {
			if state.ConversationID != selectedConversation || state.ThreadConversationID != selectedConversation || state.ThreadID.Value != input.ThreadID || state.ThreadRuntime.Value != input.RuntimeID || record.TurnID != input.ExpectedTurnID || !workstate.ResumeEligible(record, state.Messages, input.At) || !workstate.ResumeOtherWorkKnown(record.ID, state.WorkTasks) {
				return continuationConflict()
			}
			attempts := 0
			if record.Continuation != nil {
				attempts = record.Continuation.Attempts
			}
			record.Status = contracts.WorkStatusContinuing
			record.PauseReason = contracts.Null[string]()
			record.ProgressDismissedAt = contracts.Optional[float64]{}
			record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(input.At), Attempts: attempts, LastCheckpoint: workstate.Checkpoint(record.Plan)}
		}
		eligible := workstate.Eligible(record, input.At)
		if input.HumanReply {
			eligible = workstate.ReplyEligible(record, input.At)
		}
		if !workstate.ValidID(workID, workstate.IDLength) || !workstate.ValidID(input.AttemptID, workstate.IDLength) || !workstate.ValidID(input.ExpectedTurnID, workstate.ReferenceIDLength) || !workstate.ValidTime(input.At) || !workstate.ValidID(input.ThreadID, workstate.ReferenceIDLength) || record.TurnID != input.ExpectedTurnID || !eligible {
			return continuationConflict()
		}
		for _, other := range state.WorkTasks {
			if other.Continuation != nil && other.Continuation.Dispatch != nil && other.Continuation.Dispatch.ID == input.AttemptID {
				return continuationConflict()
			}
		}
		prior := record.Continuation
		if prior != nil && prior.Attempts >= workstate.MaxSafeInteger {
			return continuationConflict()
		}
		continuation := &contracts.WorkContinuation{NextAt: contracts.Some(record.ExecutionEndedAt.Value + workstate.InitialDelayMs), Attempts: 1, LastCheckpoint: workstate.Checkpoint(record.Plan)}
		if prior != nil {
			*continuation = *prior
			continuation.Attempts++
		}
		if input.HumanReply {
			continuation.NextAt = contracts.Some(input.At)
			continuation.NoProgressCount = 0
			record.Status = contracts.WorkStatusContinuing
		}
		continuation.Dispatch = &contracts.ContinuationDispatch{ID: input.AttemptID, FromTurnID: input.ExpectedTurnID, RuntimeID: input.RuntimeID, ThreadID: input.ThreadID, Phase: contracts.ContinuationDispatchPhaseClaimed, CreatedAt: input.At}
		if !workstate.SafeContinuation(continuation) {
			return continuationConflict()
		}
		record.Continuation = continuation
		record.UpdatedAt = input.At
		result = record
		return nil
	})
	return result, err
}

func continuationAttempt(state *contracts.State, workID, attemptID string) (*contracts.WorkRecord, *contracts.WorkContinuation, *contracts.ContinuationDispatch, error) {
	record, err := FindWork(state, workID)
	if err != nil || !workstate.ValidID(workID, workstate.IDLength) || !workstate.ValidID(attemptID, workstate.IDLength) || !workstate.SafeContinuation(record.Continuation) || record.Continuation.Dispatch == nil || record.Continuation.Dispatch.ID != attemptID || record.Status == contracts.WorkStatusCancelled {
		return nil, nil, nil, continuationConflict()
	}
	dispatch := record.Continuation.Dispatch
	if dispatch.TurnID != "" && dispatch.TurnID != record.TurnID || dispatch.TurnID == "" && dispatch.FromTurnID != record.TurnID {
		return nil, nil, nil, continuationConflict()
	}
	return record, record.Continuation, dispatch, nil
}

func (value *Store) SetWorkContinuationPhase(ctx context.Context, workID, attemptID string, phase contracts.ContinuationDispatchPhase) (*contracts.WorkRecord, error) {
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, _, dispatch, err := continuationAttempt(state, workID, attemptID)
		if err != nil {
			return err
		}
		if dispatch.Phase != contracts.ContinuationDispatchPhaseClaimed || (phase != contracts.ContinuationDispatchPhaseSubmitting && phase != contracts.ContinuationDispatchPhaseUnknown) || record.Status != contracts.WorkStatusContinuing {
			return continuationConflict()
		}
		dispatch.Phase = phase
		if phase == contracts.ContinuationDispatchPhaseUnknown {
			record.Status = contracts.WorkStatusUnknown
		}
		record.UpdatedAt = value.Timestamp()
		result = record
		return nil
	})
	return result, err
}

func (value *Store) BindWorkContinuation(ctx context.Context, workID, attemptID, turnID string) (*contracts.WorkRecord, error) {
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, _, dispatch, err := continuationAttempt(state, workID, attemptID)
		if err != nil {
			return err
		}
		if dispatch.Phase != contracts.ContinuationDispatchPhaseSubmitting || record.Status != contracts.WorkStatusContinuing || !workstate.ValidID(turnID, workstate.ReferenceIDLength) {
			return continuationConflict()
		}
		for _, other := range state.WorkTasks {
			if other.TurnID == turnID || slices.Contains(other.TurnIDs, turnID) {
				return continuationConflict()
			}
		}
		record.TurnIDs = uniqueStrings(record.TurnIDs, []string{record.TurnID, turnID})
		record.TurnID = turnID
		record.Status = contracts.WorkStatusRunning
		dispatch.Phase = contracts.ContinuationDispatchPhaseAcknowledged
		dispatch.TurnID = turnID
		record.UpdatedAt = value.Timestamp()
		record.ExecutionEndedAt = contracts.Optional[float64]{}
		record.PauseReason = contracts.Optional[string]{}
		record.ProgressDismissedAt = contracts.Optional[float64]{}
		record.CancelledAt = contracts.Optional[float64]{}
		result = record
		return nil
	})
	return result, err
}

type SettleContinuationOptions struct {
	Status        contracts.WorkStatus
	At            float64
	Submitted     bool
	RejectedStart *RejectedContinuationStart
}

// RejectedContinuationStart identifies a start request that the transport
// explicitly proved was not accepted. It cannot retire an acknowledged turn.
type RejectedContinuationStart struct {
	ConversationID string
	FromTurnID     string
	RuntimeID      string
	ThreadID       string
}

func (value *Store) SettleWorkContinuation(ctx context.Context, workID, attemptID string, input SettleContinuationOptions) (*contracts.WorkRecord, error) {
	if input.At == 0 {
		input.At = value.Timestamp()
	}
	if input.Status == "" {
		input.Status = contracts.WorkStatusFailed
	}
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, c, dispatch, err := continuationAttempt(state, workID, attemptID)
		if err != nil {
			return err
		}
		if !workstate.ValidTime(input.At) {
			return continuationConflict()
		}
		switch input.Status {
		case contracts.WorkStatusFailed, contracts.WorkStatusContinuing, contracts.WorkStatusPaused, contracts.WorkStatusCancelled, contracts.WorkStatusUnknown:
		default:
			return continuationConflict()
		}
		knownRejected := false
		if proof := input.RejectedStart; proof != nil {
			unacknowledged := dispatch.Phase == contracts.ContinuationDispatchPhaseSubmitting && dispatch.TurnID == ""
			if input.Submitted || input.Status != contracts.WorkStatusFailed && input.Status != contracts.WorkStatusPaused || !unacknowledged {
				return continuationConflict()
			}
			sameTurn := proof.FromTurnID == record.TurnID && proof.FromTurnID == dispatch.FromTurnID
			sameExecutor := proof.RuntimeID == dispatch.RuntimeID && proof.ThreadID == dispatch.ThreadID
			if proof.ConversationID != state.ConversationID || !sameTurn || !sameExecutor {
				return continuationConflict()
			}
			sameBinding := state.ThreadRuntime.Value == proof.RuntimeID && state.ThreadID.Value == proof.ThreadID
			if state.ThreadConversationID != proof.ConversationID || !sameBinding {
				return continuationConflict()
			}
			knownRejected = true
		}

		if dispatch.Phase != contracts.ContinuationDispatchPhaseClaimed && !knownRejected || input.Submitted || input.Status == contracts.WorkStatusUnknown {
			record.Status = contracts.WorkStatusUnknown
			record.PauseReason = contracts.Some("continuation-unconfirmed")
			c.NextAt = contracts.Null[float64]()
			dispatch.Phase = contracts.ContinuationDispatchPhaseUnknown
		} else {
			c.Dispatch = nil
			c.NextAt = contracts.Some(min(float64(workstate.MaxTimestamp), input.At+workstate.Delay(c.NoProgressCount)))
			record.Status = contracts.WorkStatusContinuing
			if input.Status == contracts.WorkStatusPaused || input.Status == contracts.WorkStatusCancelled {
				record.Status = input.Status
				c.NextAt = contracts.Null[float64]()
			}
			if input.Status == contracts.WorkStatusPaused {
				record.PauseReason = contracts.Some("continuation-paused")
			}
			if input.Status == contracts.WorkStatusCancelled {
				record.CancelledAt = contracts.Some(input.At)
				record.ExecutionEndedAt = contracts.Some(input.At)
			}
		}
		record.UpdatedAt = input.At
		result = record
		return nil
	})
	return result, err
}

func (value *Store) FinishUnboundWorkContinuation(ctx context.Context, workID, attemptID, turnID string, status contracts.WorkStatus, at float64) (*contracts.WorkRecord, error) {
	if at == 0 {
		at = value.Timestamp()
	}
	var result *contracts.WorkRecord
	err := value.Mutate(ctx, func(state *contracts.State) error {
		record, err := FindWork(state, workID)
		if err != nil {
			return continuationConflict()
		}
		c := record.Continuation
		if !workstate.ValidID(attemptID, workstate.IDLength) || !workstate.ValidID(turnID, workstate.ReferenceIDLength) || !workstate.ValidTime(at) || (status != contracts.WorkStatusPaused && status != contracts.WorkStatusCancelled) || !workstate.SafeContinuation(c) || c.Dispatch == nil || c.Dispatch.ID != attemptID || (c.Dispatch.Phase != contracts.ContinuationDispatchPhaseSubmitting && c.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown) || c.Dispatch.FromTurnID != record.TurnID || c.Dispatch.TurnID != "" && c.Dispatch.TurnID != turnID || record.Status == contracts.WorkStatusCancelled {
			return continuationConflict()
		}
		for _, other := range state.WorkTasks {
			if other.TurnID == turnID || slices.Contains(other.TurnIDs, turnID) {
				return continuationConflict()
			}
		}
		record.TurnIDs = uniqueStrings(record.TurnIDs, []string{record.TurnID, turnID})
		record.TurnID = turnID
		record.Status = status
		record.PauseReason = contracts.Some("continuation-save-failed")
		record.ExecutionEndedAt = contracts.Some(at)
		record.UpdatedAt = at
		c.Dispatch = nil
		c.NextAt = contracts.Null[float64]()
		if status == contracts.WorkStatusCancelled {
			record.CancelledAt = contracts.Some(at)
		}
		result = record
		return nil
	})
	return result, err
}

var pauseReasonPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,127}$`)

func (value *Store) PauseContinuingWork(ctx context.Context, at float64, reason string) ([]string, error) {
	if at == 0 {
		at = value.Timestamp()
	}
	if reason == "" {
		reason = "user-paused"
	}
	if !workstate.ValidTime(at) || !pauseReasonPattern.MatchString(reason) {
		return nil, continuationConflict()
	}
	ids := []string{}
	err := value.Mutate(ctx, func(state *contracts.State) error {
		for index := range state.WorkTasks {
			record := &state.WorkTasks[index]
			if record.Status != contracts.WorkStatusContinuing || !workstate.ValidTime(record.ExecutionEndedAt.Value) || workstate.Unconfirmed(record) || !workstate.Unfinished(record) || record.Continuation != nil && record.Continuation.Dispatch != nil {
				continue
			}
			ids = append(ids, record.ID)
			record.Status = contracts.WorkStatusPaused
			record.PauseReason = contracts.Some(reason)
			record.UpdatedAt = at
			if record.Continuation == nil {
				record.Continuation = &contracts.WorkContinuation{LastCheckpoint: workstate.Checkpoint(record.Plan)}
			}
			record.Continuation.NextAt = contracts.Null[float64]()
		}
		if len(ids) == 0 {
			return ErrNoChange
		}
		return nil
	})
	return ids, err
}
