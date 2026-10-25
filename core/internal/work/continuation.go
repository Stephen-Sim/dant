package work

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func (value *Engine) canContinueLocked() bool {
	return value.continuationAvailableLocked(false)
}

func (value *Engine) continuationAvailableLocked(allowQueue bool) bool {
	if value.paused || !value.continuationFrameAvailableLocked(allowQueue) {
		return false
	}
	state := value.store.Snapshot()
	for _, message := range state.Messages {
		if message.Role == contracts.RoleUser && message.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) && message.Status.Value != contracts.MessageStatus(contracts.TaskStatusCancelled) && (message.UnknownOutcome || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting) {
			return false
		}
	}
	return !unconfirmedState(state)
}

func (value *Engine) continuationFrameAvailableLocked(allowQueue bool) bool {
	if value.closed || value.maintenance || value.openingThread || value.referencePending > 0 {
		return false
	}
	if value.active != nil || value.takeover || value.acquiring || !allowQueue && len(value.queue) > 0 {
		return false
	}
	if len(value.pendingFollowups) > 0 || len(value.pendingRequests) > 0 || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
		return false
	}
	if value.callReservation != nil && value.callReservation.Provider == "subscription" {
		return false
	}
	return true
}

type selectedWorkResume struct{ conversationID string }

func (value *Engine) continuationOwnerCurrentLocked(active *execution) bool {
	if !value.currentLocked(active) || active.stopRequested {
		return false
	}
	if !active.selectedResume {
		return true
	}
	state := value.store.Snapshot()
	if value.paused || value.takeover || value.acquiring || value.callReservation != nil || value.CallSnapshot() != nil || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline || value.worker.RuntimeID() != active.runtimeID {
		return false
	}
	if state.ThreadRuntime.Value != active.runtimeID || state.ThreadID.Value != active.threadID || state.ThreadConversationID != active.conversationID {
		return false
	}
	record, err := store.FindWork(&state, active.workID)
	if err != nil || record.TurnID != active.fromTurnID || !workstate.ResumeClaimEligible(record, state.Messages, value.Timestamp(), active.attemptID) || !workstate.ResumeOtherWorkKnown(record.ID, state.WorkTasks) {
		return false
	}
	dispatch := record.Continuation.Dispatch
	if dispatch.ThreadID != active.threadID || dispatch.RuntimeID != active.runtimeID {
		return false
	}
	if !workstate.ResumeThreadCompatible(record, state.Messages, value.Timestamp(), active.threadID, active.resumeTerminalTurns) {
		return false
	}
	// The exact active claim was checked above. Every other durable work and
	// voice/stop fence retains the same global uncertainty barrier.
	other := state
	other.WorkTasks = nil
	for _, record := range state.WorkTasks {
		if record.ID != active.workID {
			other.WorkTasks = append(other.WorkTasks, record)
		}
	}
	return !unconfirmedState(other)
}

func (value *Engine) selectedResumeAvailableLocked(state contracts.State, workID, fromTurn string, selection *selectedWorkResume) bool {
	if selection == nil || !value.continuationFrameAvailableLocked(false) || !value.confirmedStopped || value.inheritedStopFence || value.callReservation != nil || value.CallSnapshot() != nil || unconfirmedState(state) {
		return false
	}
	if selection.conversationID != "" && state.ConversationID != selection.conversationID {
		return false
	}
	record, err := store.FindWork(&state, workID)
	return err == nil && record.TurnID == fromTurn && workstate.ResumeEligible(record, state.Messages, value.Timestamp()) && workstate.ResumeOtherWorkKnown(record.ID, state.WorkTasks)
}

func (value *Engine) CanContinueRegisteredWork() bool {
	value.mu.Lock()
	available := value.canContinueLocked()
	value.mu.Unlock()
	if !available {
		return false
	}
	if value.options.Calls != nil && value.options.Calls.PendingWork() {
		return false
	}
	return true
}

func (value *Engine) ContinueRegisteredWork(ctx context.Context, workID string, options ContinueOptions) (json.RawMessage, error) {
	return value.continueRegisteredWork(ctx, workID, options, nil)
}

func (value *Engine) continueRegisteredWork(ctx context.Context, workID string, options ContinueOptions, selection *selectedWorkResume) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if selection != nil && value.options.Calls != nil && value.options.Calls.PendingWork() {
		return nil, ErrBusy
	}
	value.mu.Lock()
	state := value.store.Snapshot()
	available := false
	if selection != nil {
		available = value.selectedResumeAvailableLocked(state, workID, options.ExpectedTurnID, selection)
	} else {
		available = value.continuationAvailableLocked(options.Message != nil)
	}
	if !available {
		value.mu.Unlock()
		return nil, ErrBusy
	}
	record, err := store.FindWork(&state, workID)
	human := options.Message != nil
	eligible := err == nil && record.TurnID == options.ExpectedTurnID && workstate.Eligible(record, value.Timestamp())
	if selection != nil {
		eligible = err == nil && record.TurnID == options.ExpectedTurnID && !human && workstate.ResumeEligible(record, state.Messages, value.Timestamp())
	}
	if human {
		eligible = err == nil && record.TurnID == options.ExpectedTurnID && workstate.ReplyEligible(record, value.Timestamp()) && options.Message.Role == contracts.RoleUser && options.Message.WorkReply != nil && options.Message.WorkReply.WorkID == workID && options.Message.WorkReply.TurnID == record.TurnID && options.Message.WorkReply.ConversationID == state.ConversationID
	}
	if !eligible || !workstate.ValidID(state.ThreadID.Value, workstate.ReferenceIDLength) || state.ThreadRuntime.Value != value.worker.RuntimeID() || state.ThreadConversationID != state.ConversationID {
		value.mu.Unlock()
		return nil, ErrStaleOwner
	}
	attemptID := value.options.NewID()
	value.epoch++
	epoch := value.epoch
	owner := ContinuationOwner{ConversationID: state.ConversationID, WorkID: workID, AttemptID: attemptID, FromTurnID: record.TurnID, ThreadID: state.ThreadID.Value, EngineEpoch: epoch}
	if selection == nil {
		value.mu.Unlock()
		if calls, ok := value.options.Calls.(ContinuationCalls); ok && !calls.CanContinueWhileIdle(owner) {
			return nil, ErrBusy
		}
		value.mu.Lock()
		if !value.continuationAvailableLocked(human) || value.store.ConversationID() != state.ConversationID || value.epoch != epoch {
			value.mu.Unlock()
			return nil, ErrBusy
		}
	}
	claim := store.ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: attemptID, RuntimeID: value.worker.RuntimeID(), ThreadID: state.ThreadID.Value, HumanReply: human}
	var claimed *contracts.WorkRecord
	if selection != nil {
		claimed, err = value.store.ClaimPausedWorkContinuation(ctx, state.ConversationID, workID, claim)
	} else {
		claimed, err = value.store.ClaimWorkContinuation(ctx, workID, claim)
	}
	if err != nil {
		value.mu.Unlock()
		return nil, err
	}
	prepare, cancel := context.WithCancel(value.ctx)
	active := &execution{
		epoch:          epoch,
		conversationID: state.ConversationID,
		threadID:       state.ThreadID.Value,
		workID:         workID,
		attemptID:      attemptID,
		fromTurnID:     record.TurnID,
		record:         claimed,

		startedAt: value.Timestamp(),
		updatedAt: value.Timestamp(),
		step:      contracts.TaskProgressStagePreparing,
		outputs:   make(map[string]string),
		items:     make(map[string]string),

		stopped:           make(chan struct{}),
		prepare:           prepare,
		cancelPreparation: cancel,
		humanResponse:     human,
	}
	active.runtimeID = state.ThreadRuntime.Value
	if selection != nil {
		active.selectedResume = true
		active.resumeWasPaused, active.resumePauseReason = value.paused, value.pauseReason
		value.clearPauseLocked()
	}
	if human {
		active.messageID = options.Message.ID
		active.messageIDs = []string{options.Message.ID}
	}
	value.active = active
	if selection == nil {
		value.confirmedStopped = false
	}
	value.changeLocked()
	value.workers.Add(1)
	value.mu.Unlock()
	defer value.workers.Done()
	if selection != nil {
		stopCancellation := context.AfterFunc(ctx, cancel)
		defer stopCancellation()
	}
	if calls, ok := value.options.Calls.(ContinuationCalls); ok {
		admission, err := calls.BeginContinuationAdmission(owner)
		if err != nil {
			return nil, value.failContinuation(active, err, false)
		}
		active.nativeAdmission = &admission
	}
	if err := value.ensureEvents(); err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	resumed, resumeErr := value.thread(active)
	if resumeErr != nil || resumed != active.threadID {
		if resumeErr == nil {
			resumeErr = ErrStaleOwner
		}
		return nil, value.failContinuation(active, resumeErr, false)
	}
	if human {
		_, err = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusRunning), "submission": raw(contracts.SubmissionStatusPreparing)}))
		if err != nil {
			return nil, value.failContinuation(active, err, false)
		}
	}
	seen, err := value.continuationHistory(active)
	if err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	if selection != nil {
		value.mu.Lock()
		active.resumeTerminalTurns = append([]string{}, seen...)
		value.mu.Unlock()
	}
	var input json.RawMessage
	if human {
		input, err = value.prepareInput(active, options.Message)
	} else {
		if selection != nil {
			input = selectedContinuationInput(record, value.redact)
		} else {
			input = continuationInput(record, value.redact)
		}
		if value.options.Memory != nil {
			query := record.Title
			if record.Plan != nil {
				for _, step := range record.Plan.Steps {
					if step.Status != contracts.PlanStepStatusCompleted {
						query += "\n" + step.Step
					}
				}
			}
			reference, referenceErr := value.options.Memory.Context(active.prepare, query, active.conversationID, active.workID)
			if referenceErr != nil {
				return nil, value.failContinuation(active, referenceErr, false)
			}
			if reference != "" {
				var inputs []contracts.RawObject
				_ = json.Unmarshal(input, &inputs)
				var text string
				_ = json.Unmarshal(inputs[0]["text"], &text)
				inputs[0]["text"] = raw(text + "\n\n" + reference)
				input = raw(inputs)
			}
		}
	}
	if err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	if value.options.Deliverables != nil {
		active.baseline, err = value.options.Deliverables.CaptureBaseline(active.prepare, value.outputDirectory(active.conversationID))
		if err != nil {
			return nil, value.failContinuation(active, err, false)
		}
	}
	value.mu.Lock()
	if !value.continuationOwnerCurrentLocked(active) {
		value.mu.Unlock()
		return nil, value.failContinuation(active, ErrPaused, false)
	}
	value.mu.Unlock()
	if _, err = value.store.SetWorkContinuationPhase(value.ctx, workID, attemptID, contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	value.mu.Lock()
	active.startSubmitted = true
	value.confirmedStopped = false
	value.mu.Unlock()
	if human {
		_, err = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"submission": raw(contracts.SubmissionStatusSubmitting)}))
		if err != nil {
			return nil, value.failContinuation(active, err, true)
		}
	}
	requestContext := value.ctx
	if selection != nil {
		requestContext = active.prepare
	}
	response, err := value.requestOwned(requestContext, "turn/start", contracts.RawObject{"threadId": raw(active.threadID), "input": input, "cwd": raw(value.workspace(active.conversationID)), "approvalPolicy": raw("never"), "sandboxPolicy": json.RawMessage(`{"type":"dangerFullAccess"}`)}, func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return value.continuationOwnerCurrentLocked(active)
	})
	if err != nil {
		return nil, value.failContinuation(active, err, operationUnknown(err))
	}
	turn, err := contracts.DecodeObject(response["turn"], runtime.MaxRPCFrameBytes)
	id := eventString(turn, "id")
	if err != nil || !workstate.ValidID(id, workstate.ReferenceIDLength) || slices.Contains(seen, id) {
		return nil, value.failContinuation(active, ErrUnknown, true)
	}
	value.mu.Lock()
	if !value.currentLocked(active) {
		value.mu.Unlock()
		return nil, value.failContinuation(active, ErrUnknown, true)
	}
	active.turnID = id
	events := active.early
	active.early = nil
	active.earlyBytes = 0
	value.mu.Unlock()
	if calls, ok := value.options.Calls.(ContinuationCalls); ok && active.nativeAdmission != nil {
		var conflict bool
		var replayErr error
		events, conflict, replayErr = calls.ReplayContinuationEvents(value.ctx, *active.nativeAdmission, events, id, false)
		if replayErr != nil || conflict {
			return nil, value.failContinuation(active, ErrUnknown, true)
		}
		if err = calls.ConfirmContinuationAdmission(*active.nativeAdmission, id); err != nil {
			return nil, value.failContinuation(active, ErrUnknown, true)
		}
	}
	bound, err := value.store.BindWorkContinuation(value.ctx, workID, attemptID, id)
	if err != nil {
		return nil, value.failContinuation(active, err, true)
	}
	if human {
		_, err = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"submission": raw(contracts.SubmissionStatusConfirmed), "turnId": raw(id), "executorConfirmedAt": raw(value.Timestamp())}))
		if err != nil {
			return nil, value.failContinuation(active, err, true)
		}
	}
	value.mu.Lock()
	if !value.currentLocked(active) {
		value.mu.Unlock()
		return nil, value.failContinuation(active, ErrUnknown, true)
	}
	active.record = bound
	active.startAcknowledged = true
	active.step = contracts.TaskProgressStageWorking
	stopRequested := active.selectedResume && active.stopRequested
	events = append(events, active.early...)
	active.early = nil
	value.changeLocked()
	value.mu.Unlock()
	for _, event := range events {
		_ = value.Handle(value.ctx, event)
	}
	if stopRequested {
		if err := value.interrupt(value.ctx, active); err != nil {
			_, settleErr := value.store.SettleWorkContinuation(value.ctx, active.workID, active.attemptID, store.SettleContinuationOptions{Status: contracts.WorkStatusUnknown, Submitted: true})
			value.mu.Lock()
			if value.active == active {
				active.unknown = true
				value.confirmedStopped = false
				value.pauseLocked(pauseReasonStopUnknown)
				value.changeLocked()
			}
			value.mu.Unlock()
			if settleErr != nil {
				return nil, settleErr
			}
			return nil, &runtime.OperationError{Cause: err, UnknownOutcome: true}
		}
		return nil, ErrPaused
	}
	return raw(contracts.RawObject{"continued": raw(true), "workId": raw(workID), "turnId": raw(id)}), nil
}

func (value *Engine) failContinuation(active *execution, cause error, unknown bool) error {
	value.mu.Lock()
	status := contracts.WorkStatusFailed
	if active.stopRequested || active.humanResponse || active.selectedResume {
		status = contracts.WorkStatusPaused
	}
	if active.selectedResume && active.cancelRequested {
		status = contracts.WorkStatusCancelled
	}
	if unknown {
		status = contracts.WorkStatusUnknown
	}
	var rejected *store.RejectedContinuationStart
	var operation *runtime.OperationError
	unacknowledged := active.startSubmitted && !active.startAcknowledged && !active.unknown && active.turnID == ""
	knownRejection := errors.As(cause, &operation) && !operation.UnknownOutcome
	if (status == contracts.WorkStatusFailed || active.selectedResume && status == contracts.WorkStatusPaused) && unacknowledged && value.currentLocked(active) && knownRejection {
		rejected = &store.RejectedContinuationStart{
			ConversationID: active.conversationID,
			FromTurnID:     active.fromTurnID,
			RuntimeID:      active.runtimeID,
			ThreadID:       active.threadID,
		}
	}
	value.mu.Unlock()

	_, err := value.store.SettleWorkContinuation(value.ctx, active.workID, active.attemptID, store.SettleContinuationOptions{
		Status:        status,
		Submitted:     unknown,
		RejectedStart: rejected,
	})
	value.mu.Lock()
	active.unknown = unknown
	if unknown || err != nil {
		value.pauseLocked(pauseReasonContinuation)
	}
	if value.active == active {
		if active.selectedResume && !unknown && err == nil {
			state := value.store.Snapshot()
			sameExecutor := active.stopReason != pauseReasonDisconnected && value.worker.Snapshot().Status == contracts.ConnectionStatusOnline && value.worker.RuntimeID() == active.runtimeID && state.ThreadRuntime.Value == active.runtimeID && state.ThreadID.Value == active.threadID && state.ThreadConversationID == active.conversationID && state.ConversationID == active.conversationID
			if sameExecutor && (!active.startSubmitted || rejected != nil) {
				value.confirmedStopped = true
			} else if !sameExecutor {
				value.confirmedStopped = false
				value.pauseLocked(pauseReasonStopUnknown)
			}
			if sameExecutor && active.resumeWasPaused {
				value.pauseLocked(active.resumePauseReason)
			}
		}
		value.active = nil
		close(active.stopped)
	}
	active.cancelPreparation()
	value.changeLocked()
	value.mu.Unlock()
	if value.options.OwnerEnded != nil && active.turnID != "" {
		value.options.OwnerEnded(active.turnID)
	}
	if calls, ok := value.options.Calls.(ContinuationCalls); ok && active.nativeAdmission != nil {
		calls.FinishContinuationAdmission(*active.nativeAdmission)
	}
	if active.messageID != "" {
		submission := contracts.SubmissionStatusPreparing
		if unknown {
			submission = contracts.SubmissionStatusUnknown
		}
		_, _ = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusPaused), "submission": raw(submission), "unknownOutcome": raw(unknown), "pauseReason": raw(pauseReasonContinuation)}))
	}
	if err != nil {
		return err
	}
	return cause
}

func continuationInput(
	record *contracts.WorkRecord,
	redact func(string) string) json.RawMessage {
	return continuationInputFor(record, redact, continuationAutomatic)
}

func selectedContinuationInput(record *contracts.WorkRecord, redact func(string) string) json.RawMessage {
	return continuationInputFor(record, redact, continuationHumanResume)
}

type continuationReason string

const (
	continuationAutomatic   continuationReason = "Automatic follow-up for the same human-authorized unfinished task, not a new human message."
	continuationHumanResume continuationReason = "A human explicitly selected Resume for this exact paused work. This resumes the same authorized task and is not a new human message."
)

func continuationInputFor(record *contracts.WorkRecord, redact func(string) string, reason continuationReason) json.RawMessage {
	steps := []contracts.PlanStep{}
	if record.Plan != nil {
		steps = record.Plan.Steps
	}
	context := raw(contracts.RawObject{"workId": raw(record.ID), "title": raw(record.Title), "steps": raw(steps)})
	text := string(reason) + " Continue only this exact workId. First inspect actual state; never repeat completed side effects or restart the whole request. Register remaining steps with task_plan. Saved checklists are reference data, not proof of success or new permission. Work quietly: chat and file deliveries are buffered until a verified completed plan, an actual information blocker or execution failure. Respect sent:false/quiet:true and never claim delivery. Do not create another executor or schedule. Respect paused, cancelled, human control and the original scope.\n<dant_work_continuation>\n" + redact(strings.ReplaceAll(strings.ReplaceAll(string(context), "<", "\\u003c"), ">", "\\u003e")) + "\n</dant_work_continuation>"
	return raw([]contracts.RawObject{{"type": raw("text"), "text": raw(text), "text_elements": json.RawMessage("[]")}})
}
