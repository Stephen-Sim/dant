package work

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const StopConfirmationTimeout = 15 * time.Second

func (value *Engine) Pause(ctx context.Context) error {
	return value.pause(ctx, pauseReasonUser)
}

func (value *Engine) pause(ctx context.Context, reason string) error {
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return ErrClosed
	}
	// Taking control cannot replace an earlier stop with a pause that a new
	// request could clear after the computer is returned.
	if reason == pauseReasonHumanControl && value.paused && value.pauseReason != pauseReasonHumanControl {
		reason = value.pauseReason
		if reason == "" {
			reason = pauseReasonUnknown
		}
	}
	value.paused = true
	value.pauseReason = reason
	active := value.active
	queued := append([]string{}, value.queue...)
	value.queue = []string{}
	if active != nil {
		active.pauseOnly = true
		active.stopRequested = true
		active.stopReason = reason
		active.cancelPreparation()
	}
	value.changeLocked()
	value.mu.Unlock()
	_, err := value.store.PauseContinuingWork(value.ctx, 0, reason)
	value.mu.Lock()
	if updateErr := value.pauseQueuedLocked(value.ctx, queued, reason); updateErr != nil && err == nil {
		err = updateErr
	}
	value.mu.Unlock()
	if active != nil {
		if stopErr := value.interrupt(ctx, active); stopErr != nil {
			return stopErr
		}
	}
	if value.options.Calls != nil {
		if callErr := value.options.Calls.PauseWork(ctx); callErr != nil {
			return callErr
		}
	}
	return err
}

func (value *Engine) interrupt(ctx context.Context, active *execution) error {
	value.mu.Lock()
	if value.active != active {
		value.mu.Unlock()
		return nil
	}
	active.stopRequested = true
	active.cancelPreparation()
	turn, thread := active.turnID, active.threadID
	submitted := active.startSubmitted
	reason := active.stopReason
	if reason == "" {
		reason = pauseReasonUser
	}
	value.mu.Unlock()
	if value.options.OwnerEnded != nil && turn != "" {
		value.options.OwnerEnded(turn)
	}
	if !submitted {
		return value.finish(active, contracts.TaskStatusPaused, reason)
	}
	if turn != "" && thread != "" {
		if _, err := value.worker.Request(value.ctx, "turn/interrupt", contracts.RawObject{"threadId": raw(thread), "turnId": raw(turn)}); err != nil {
			value.mu.Lock()
			active.unknown = true
			value.pauseLocked(pauseReasonStopUnknown)
			value.changeLocked()
			value.mu.Unlock()
			return ErrUnknown
		}
	}
	deadline, cancel := context.WithTimeout(ctx, StopConfirmationTimeout)
	defer cancel()
	select {
	case <-active.stopped:
		return nil
	case <-deadline.Done():
		return ErrUnknown
	case <-value.ctx.Done():
		return ErrClosed
	}
}

func (value *Engine) ResumePaused(ctx context.Context, ids []string, options ResumeOptions) ([]string, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance || value.takeover || value.acquiring || value.active != nil && value.active.unknown {
		return nil, ErrBusy
	}
	if value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
		return nil, runtime.ErrDisconnected
	}
	call := value.CallSnapshot()
	if call != nil && call.Provider == "subscription" {
		return nil, ErrBusy
	}
	selected := []string{}
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		targets := []*contracts.ChatMessage{}
		if ids == nil {
			for _, message := range state.Messages {
				if message.Role == contracts.RoleUser && message.Status.Value == contracts.MessageStatus(contracts.TaskStatusPaused) {
					targets = append(targets, message)
				}
			}
		} else {
			for _, id := range ids {
				message, err := store.FindMessage(state, id)
				if err != nil {
					return ErrStaleOwner
				}
				if !slices.ContainsFunc(targets, func(prior *contracts.ChatMessage) bool { return prior.ID == id }) {
					targets = append(targets, message)
				}
			}
		}
		for _, message := range targets {
			if message.Role != contracts.RoleUser || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) && message.Status.Value != contracts.MessageStatus(contracts.TaskStatusUnknown) && message.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) {
				return ErrStaleOwner
			}
			if call != nil && message.VoiceCallID != "" && message.TurnID.Value == "" {
				return ErrBusy
			}
			for _, record := range state.WorkTasks {
				if message.TurnID.Value != "" && (record.ID == message.WorkID || slices.Contains(record.TurnIDs, message.TurnID.Value)) && record.TurnID != message.TurnID.Value {
					return ErrStaleOwner
				}
			}
			unknown := message.UnknownOutcome || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting
			if unknown && !options.ConfirmUnknown {
				return ErrUnknown
			}
			if len(value.queue)+len(selected) >= MaxQueue {
				return runtime.ErrBackpressure
			}
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))
			message.Submission = contracts.Some(contracts.SubmissionStatusNotSubmitted)
			message.UnknownOutcome = false
			message.Error = contracts.Null[string]()
			message.TurnID = contracts.Null[string]()
			message.ExecutorConfirmedAt = contracts.Null[float64]()
			message.PauseReason = contracts.Null[string]()
			message.QueuedAt = contracts.Some(value.Timestamp())
			selected = append(selected, message.ID)
		}
		if len(selected) == 0 {
			return store.ErrNoChange
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(selected) > 0 {
		value.clearPauseLocked()
	}
	value.queue = append(value.queue, selected...)
	value.changeLocked()
	value.Wake()
	return selected, nil
}

func (value *Engine) Acquire(ctx context.Context) error {
	value.mu.Lock()
	if value.closed || value.maintenance || value.acquiring && !value.computerAcquireReserved || value.takeover {
		value.mu.Unlock()
		return ErrBusy
	}
	value.computerAcquireReserved = false
	value.acquiring = true
	value.changeLocked()
	value.mu.Unlock()
	err := value.pause(ctx, pauseReasonHumanControl)
	value.mu.Lock()
	value.acquiring = false
	if err == nil {
		value.takeover = true
	}
	value.changeLocked()
	value.mu.Unlock()
	return err
}

func (value *Engine) BeginComputerAcquire() error {
	if value.CallSnapshot() != nil {
		return ErrBusy
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance || value.takeover || value.acquiring || value.callReservation != nil {
		return ErrBusy
	}
	queued := append([]string{}, value.queue...)
	if err := value.pauseQueuedLocked(value.ctx, queued, "human-control"); err != nil {
		return err
	}
	value.queue = []string{}
	value.acquiring = true
	value.computerAcquireReserved = true
	value.changeLocked()
	return nil
}

func (value *Engine) AbortComputerAcquire() {
	value.mu.Lock()
	if value.computerAcquireReserved {
		value.computerAcquireReserved = false
		value.acquiring = false
		value.changeLocked()
	}
	value.mu.Unlock()
}

func (value *Engine) Release() error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed {
		return ErrClosed
	}
	value.takeover = false
	value.acquiring = false
	value.changeLocked()
	return nil
}

func (value *Engine) ConfirmStopped(ctx context.Context) error {
	if value.inheritedStopFence {
		return ErrUnknown
	}
	confirmed, err := value.worker.TerminateConfirmed(ctx)
	if err != nil || !confirmed {
		return ErrUnknown
	}
	value.mu.Lock()
	value.confirmedStopped = true
	active := value.active
	closed := value.closed
	if active != nil {
		active.terminal = true
	}
	value.mu.Unlock()
	if active != nil && !closed {
		if err := value.finish(active, contracts.TaskStatusPaused, "executor-terminated"); err != nil {
			return err
		}
	}
	return value.store.Mutate(ctx, func(state *contracts.State) error {
		cleared := clearStopFence(state)
		if _, present := state.Extra[voiceTaskFenceKey]; !present && !cleared {
			return store.ErrNoChange
		}
		delete(state.Extra, voiceTaskFenceKey)
		return nil
	})
}

type ProgressTarget struct {
	ID             string
	Kind           string
	TurnID         contracts.Optional[string]
	CallID         contracts.Optional[string]
	ConversationID string
}

func (value *Engine) CancelProgress(ctx context.Context, target ProgressTarget, pauseOnly bool) (json.RawMessage, error) {
	if !target.TurnID.Present || !target.TurnID.Null && !workstate.ValidID(target.TurnID.Value, workstate.ReferenceIDLength) || target.CallID.Present && !target.CallID.Null && !workstate.ValidID(target.CallID.Value, workstate.ReferenceIDLength) {
		return nil, store.ErrInvalidState
	}
	state := value.store.Snapshot()
	if target.ConversationID != "" && target.ConversationID != state.ConversationID {
		return nil, ErrStaleOwner
	}
	var turn, workID string
	ids := []string{}
	switch target.Kind {
	case "task":
		message, err := store.FindMessage(&state, target.ID)
		if err != nil || message.Role != contracts.RoleUser {
			return nil, ErrStaleOwner
		}
		turn = message.TurnID.Value
		ids = []string{message.ID}
		workID = message.WorkID
	case "work":
		record, err := store.FindWork(&state, target.ID)
		if err != nil {
			return nil, err
		}
		turn = record.TurnID
		workID = record.ID
	case "active":
		turn = target.TurnID.Value
	default:
		return nil, ErrStaleOwner
	}
	if target.TurnID.Present && (target.TurnID.Null && turn != "" || !target.TurnID.Null && target.TurnID.Value != turn) {
		return nil, ErrStaleOwner
	}
	value.mu.Lock()
	if value.closed || value.maintenance || value.store.ConversationID() != state.ConversationID {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	active := value.active
	owned := active != nil && (active.turnID == turn && turn != "" || !active.startAcknowledged && (workID != "" && active.workID == workID && active.fromTurnID == turn || turn == "" && (target.Kind == "active" && (target.ID == "current" || slices.Contains(active.messageIDs, target.ID)) || target.Kind == "task" && slices.Contains(active.messageIDs, target.ID))))
	if owned {
		if target.CallID.Present && (target.CallID.Null && active.callID != "" || !target.CallID.Null && target.CallID.Value != active.callID) {
			value.mu.Unlock()
			return nil, ErrStaleOwner
		}
		if active.unknown || active.stopRequested || active.finishing || workID != "" && active.workID != "" && workID != active.workID {
			value.mu.Unlock()
			return nil, ErrUnknown
		}
		active.cancelRequested = !pauseOnly
		active.pauseOnly = pauseOnly
		active.stopRequested = true
		if pauseOnly {
			active.stopReason = pauseReasonUser
		}
		active.cancelPreparation()
		value.changeLocked()
		value.mu.Unlock()
		if err := value.interrupt(ctx, active); err != nil {
			return nil, err
		}
		return raw(contracts.RawObject{"ok": raw(true), "cancelled": raw(!pauseOnly), "paused": raw(pauseOnly)}), nil
	}
	if active != nil && slices.Contains(active.messageIDs, target.ID) {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	defer value.mu.Unlock()

	err := value.store.Mutate(ctx, func(current *contracts.State) error {
		if current.ConversationID != state.ConversationID {
			return ErrStaleOwner
		}
		now := value.Timestamp()
		var record *contracts.WorkRecord
		if workID != "" {
			var err error
			record, err = store.FindWork(current, workID)
			if err != nil || record.TurnID != turn {
				return ErrStaleOwner
			}
			if record.UnknownOutcome || record.Status == contracts.WorkStatusUnknown ||
				record.Submission.Value == contracts.SubmissionStatusUnknown ||
				record.Submission.Value == contracts.SubmissionStatusSubmitting ||
				workstate.Unconfirmed(record) || record.Continuation != nil && record.Continuation.Dispatch != nil {
				return ErrUnknown
			}
		}
		selected := []*contracts.ChatMessage{}
		for _, message := range current.Messages {
			if message.Role == contracts.RoleUser && (slices.Contains(ids, message.ID) || turn != "" && message.TurnID.Value == turn) {
				if message.TurnID.Value != turn {
					return ErrStaleOwner
				}
				if message.UnknownOutcome || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting {
					return ErrUnknown
				}
				selected = append(selected, message)
			}
		}
		if record == nil && len(selected) == 0 {
			return ErrStaleOwner
		}
		for _, message := range selected {
			if !slices.Contains(ids, message.ID) {
				ids = append(ids, message.ID)
			}
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusCancelled))
			message.CancelledAt = contracts.Some(now)
			message.PauseReason = contracts.Null[string]()
			if pauseOnly {
				message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
				message.CancelledAt = contracts.Null[float64]()
				message.PauseReason = contracts.Some("user-paused")
			}
		}
		if record != nil {
			record.Status = contracts.WorkStatusCancelled
			record.CancelledAt = contracts.Some(now)
			if pauseOnly {
				record.Status = contracts.WorkStatusPaused
				record.CancelledAt = contracts.Null[float64]()
				record.PauseReason = contracts.Some("user-paused")
			}
			record.UpdatedAt = now
			if !record.ExecutionEndedAt.Present {
				record.ExecutionEndedAt = contracts.Some(now)
			}
			if record.Continuation != nil {
				record.Continuation.NextAt = contracts.Null[float64]()
				record.Continuation.Dispatch = nil
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	value.queue = slices.DeleteFunc(value.queue, func(id string) bool {
		return slices.Contains(ids, id)
	})
	value.changeLocked()
	return raw(contracts.RawObject{"ok": raw(true), "cancelled": raw(!pauseOnly), "paused": raw(pauseOnly)}), nil
}

func (value *Engine) RequestWorkCancellation(ctx context.Context, id string, owner ToolContext) (json.RawMessage, error) {
	if !owner.IsCurrent() {
		return nil, ErrStaleOwner
	}
	state := value.store.Snapshot()
	record, err := store.FindWork(&state, id)
	if err != nil {
		return nil, err
	}
	if record.Status != contracts.WorkStatusRunning && record.Status != contracts.WorkStatusWaitingUser && record.Status != contracts.WorkStatusContinuing {
		return nil, ErrStaleOwner
	}
	value.mu.Lock()
	active := value.active
	if active != nil && active.turnID == record.TurnID {
		if active.unknown || active.stopRequested || !active.startAcknowledged {
			value.mu.Unlock()
			return nil, ErrUnknown
		}
		target := ProgressTarget{ID: id, Kind: "work", TurnID: contracts.Some(record.TurnID), ConversationID: state.ConversationID}
		value.workers.Add(1)
		value.mu.Unlock()
		go func() {
			defer value.workers.Done()
			_, _ = value.CancelProgress(value.ctx, target, false)
		}()
		return raw(contracts.RawObject{"cancelRequested": raw(true), "workId": raw(id), "turnId": raw(record.TurnID)}), nil
	}
	value.mu.Unlock()
	return value.CancelProgress(ctx, ProgressTarget{ID: id, Kind: "work", TurnID: contracts.Some(record.TurnID), ConversationID: state.ConversationID}, false)
}

func operationUnknown(err error) bool {
	var operation *runtime.OperationError
	return !errors.As(err, &operation) || operation.UnknownOutcome
}
