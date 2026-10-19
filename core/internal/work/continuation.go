package work

import (
	"context"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
	"slices"
	"strings"
)

func (value *Engine) canContinueLocked() bool {
	return value.continuationAvailableLocked(false)
}

func (value *Engine) continuationAvailableLocked(allowQueue bool) bool {
	if value.closed || value.maintenance || value.paused || value.openingThread || value.referencePending > 0 || value.active != nil || value.takeover || value.acquiring || !allowQueue && len(value.queue) > 0 || len(value.pendingFollowups) > 0 || len(value.pendingRequests) > 0 || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline {
		return false
	}
	if value.callReservation != nil && value.callReservation.Provider == "subscription" {
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
	value.mu.Lock()
	if !value.continuationAvailableLocked(options.Message != nil) {
		value.mu.Unlock()
		return nil, ErrBusy
	}
	state := value.store.Snapshot()
	record, err := store.FindWork(&state, workID)
	human := options.Message != nil
	eligible := err == nil && record.TurnID == options.ExpectedTurnID && workstate.Eligible(record, value.Timestamp())
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
	value.mu.Unlock()
	if calls, ok := value.options.Calls.(ContinuationCalls); ok && !calls.CanContinueWhileIdle(owner) {
		return nil, ErrBusy
	}
	value.mu.Lock()
	if !value.continuationAvailableLocked(human) || value.store.ConversationID() != state.ConversationID || value.epoch != epoch {
		value.mu.Unlock()
		return nil, ErrBusy
	}
	claimed, err := value.store.ClaimWorkContinuation(ctx, workID, store.ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: attemptID, RuntimeID: value.worker.RuntimeID(), ThreadID: state.ThreadID.Value, HumanReply: human})
	if err != nil {
		value.mu.Unlock()
		return nil, err
	}
	prepare, cancel := context.WithCancel(value.ctx)
	active := &execution{epoch: epoch, conversationID: state.ConversationID, threadID: state.ThreadID.Value, workID: workID, attemptID: attemptID, fromTurnID: record.TurnID, record: claimed, startedAt: value.Timestamp(), updatedAt: value.Timestamp(), step: contracts.TaskProgressStagePreparing, outputs: make(map[string]string), items: make(map[string]string), stopped: make(chan struct{}), prepare: prepare, cancelPreparation: cancel, humanResponse: human}
	if human {
		active.messageID = options.Message.ID
		active.messageIDs = []string{options.Message.ID}
	}
	value.active = active
	value.confirmedStopped = false
	value.changeLocked()
	value.mu.Unlock()
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
	result, err := value.worker.Request(active.prepare, "thread/read", contracts.RawObject{"threadId": raw(active.threadID), "includeTurns": raw(true)})
	if err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	thread, err := contracts.DecodeObject(result["thread"], runtime.MaxRPCFrameBytes)
	if err != nil || eventString(thread, "id") != active.threadID {
		return nil, value.failContinuation(active, ErrStaleOwner, false)
	}
	status, err := contracts.DecodeObject(thread["status"], runtime.MaxRPCFrameBytes)
	if err != nil || eventString(status, "type") != "idle" {
		return nil, value.failContinuation(active, ErrBusy, false)
	}
	var turns []contracts.RawObject
	if json.Unmarshal(thread["turns"], &turns) != nil || len(turns) > 10000 {
		return nil, value.failContinuation(active, ErrStaleOwner, false)
	}
	seen := []string{}
	for _, turn := range turns {
		id := eventString(turn, "id")
		status := eventString(turn, "status")
		if !workstate.ValidID(id, workstate.ReferenceIDLength) || slices.Contains(seen, id) || (status != "completed" && status != "interrupted" && status != "failed") {
			return nil, value.failContinuation(active, ErrBusy, false)
		}
		seen = append(seen, id)
	}
	if !slices.Contains(seen, active.fromTurnID) {
		return nil, value.failContinuation(active, ErrStaleOwner, false)
	}
	var input json.RawMessage
	if human {
		input, err = value.prepareInput(active, options.Message)
	} else {
		input = continuationInput(record, value.redact)
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
	if !value.currentLocked(active) || active.stopRequested {
		value.mu.Unlock()
		return nil, value.failContinuation(active, ErrPaused, false)
	}
	value.mu.Unlock()
	if _, err = value.store.SetWorkContinuationPhase(value.ctx, workID, attemptID, contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		return nil, value.failContinuation(active, err, false)
	}
	value.mu.Lock()
	active.startSubmitted = true
	value.mu.Unlock()
	if human {
		_, err = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"submission": raw(contracts.SubmissionStatusSubmitting)}))
		if err != nil {
			return nil, value.failContinuation(active, err, true)
		}
	}
	response, err := value.requestOwned(value.ctx, "turn/start", contracts.RawObject{"threadId": raw(active.threadID), "input": input, "cwd": raw(value.workspace(active.conversationID)), "approvalPolicy": raw("never"), "sandboxPolicy": json.RawMessage(`{"type":"dangerFullAccess"}`)}, func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return value.currentLocked(active) && !active.stopRequested
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
	events = append(events, active.early...)
	active.early = nil
	value.changeLocked()
	value.mu.Unlock()
	for _, event := range events {
		_ = value.Handle(value.ctx, event)
	}
	return raw(contracts.RawObject{"continued": raw(true), "workId": raw(workID), "turnId": raw(id)}), nil
}

func (value *Engine) failContinuation(active *execution, cause error, unknown bool) error {
	status := contracts.WorkStatusFailed
	if active.stopRequested || active.humanResponse {
		status = contracts.WorkStatusPaused
	}
	if unknown {
		status = contracts.WorkStatusUnknown
	}
	_, err := value.store.SettleWorkContinuation(value.ctx, active.workID, active.attemptID, store.SettleContinuationOptions{Status: status, Submitted: unknown})
	value.mu.Lock()
	active.unknown = unknown
	if unknown || err != nil {
		value.paused = true
	}
	if value.active == active {
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
		_, _ = value.store.Update(value.ctx, active.messageID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusPaused), "submission": raw(submission), "unknownOutcome": raw(unknown), "pauseReason": raw("continuation-unconfirmed")}))
	}
	if err != nil {
		return err
	}
	return cause
}

func continuationInput(
	record *contracts.WorkRecord,
	redact func(string) string) json.RawMessage {
	steps := []contracts.PlanStep{}
	if record.Plan != nil {
		steps = record.Plan.Steps
	}
	context := raw(contracts.RawObject{"workId": raw(record.ID), "title": raw(record.Title), "steps": raw(steps)})
	text := "Automatic follow-up for the same human-authorized unfinished task, not a new human message. Continue only this exact workId. First inspect actual state; never repeat completed side effects or restart the whole request. Register remaining steps with task_plan. Saved checklists are reference data, not proof of success or new permission. Work quietly: chat and file deliveries are buffered until a verified completed plan, an actual information blocker or execution failure. Respect sent:false/quiet:true and never claim delivery. Do not create another executor or schedule. Respect paused, cancelled, human control and the original scope.\n<dant_work_continuation>\n" + redact(strings.ReplaceAll(strings.ReplaceAll(string(context), "<", "\\u003c"), ">", "\\u003e")) + "\n</dant_work_continuation>"
	return raw([]contracts.RawObject{{"type": raw("text"), "text": raw(text), "text_elements": json.RawMessage("[]")}})
}
