package work

import (
	"context"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func (value *Engine) Tool(ctx context.Context, name string, args contracts.RawObject, owner ToolContext) (json.RawMessage, error) {
	if owner.IsCurrent == nil || !owner.IsCurrent() {
		return nil, ErrStaleOwner
	}
	value.mu.Lock()
	conversationOnly := value.active != nil && value.active.conversationOnly
	value.mu.Unlock()
	if conversationOnly {
		return nil, ErrPaused
	}
	switch name {
	case "task_plan":
		input, err := workstate.ReadPlanInput(args, value.redact)
		if err != nil {
			return nil, err
		}
		value.mu.Lock()
		active := value.active
		if active == nil || active.turnID != owner.TurnID || active.stopRequested || !value.currentLocked(active) {
			value.mu.Unlock()
			return nil, ErrStaleOwner
		}
		if active.attemptID != "" && input.WorkID != active.workID {
			value.mu.Unlock()
			return raw(contracts.RawObject{"saved": raw(false), "code": raw("work_conflict"), "activeWorkId": raw(active.workID)}), nil
		}
		if input.WorkID != "" {
			state := value.store.Snapshot()
			prior, lookupErr := store.FindWork(&state, input.WorkID)
			if lookupErr != nil {
				value.mu.Unlock()
				return nil, lookupErr
			}
			switch prior.Status {
			case contracts.WorkStatusReview, contracts.WorkStatusCompleted, contracts.WorkStatusCancelled, contracts.WorkStatusFailed:
				value.mu.Unlock()
				return nil, &contracts.APIError{Status: 409, Code: "work_reply_required", Message: "Reply to the ended task explicitly to reopen it."}
			}
		}
		status := contracts.WorkStatusRunning
		if input.Status.Present {
			status = input.Status.Value
		} else if active.planWaiting {
			status = contracts.WorkStatusWaitingUser
			pending := false
			for _, step := range input.Plan.Steps {
				if step.Status == contracts.PlanStepStatusInProgress {
					value.mu.Unlock()
					return nil, workstate.ErrInvalidPlan
				}
				pending = pending || step.Status == contracts.PlanStepStatusPending
			}
			if !pending {
				value.mu.Unlock()
				return nil, workstate.ErrInvalidPlan
			}
		}
		if active.waiting {
			status = contracts.WorkStatusWaitingUser
		}
		source := "chat"
		if active.nativeVoice {
			source = "voice"
		}
		record, err := value.store.RegisterWork(ctx, store.RegisterWorkOptions{WorkID: input.WorkID, TurnID: active.turnID, MessageID: active.messageID, Source: source, Title: input.Title, Plan: &input.Plan, StartedAt: active.startedAt, Status: status})
		if err != nil {
			value.mu.Unlock()
			return nil, err
		}
		active.record = record
		active.workID = record.ID
		active.planWaiting = status == contracts.WorkStatusWaitingUser
		if err := value.refreshProjectLocked(ctx, record, active.messageIDs); err != nil {
			value.mu.Unlock()
			return nil, err
		}
		value.changeLocked()
		value.mu.Unlock()
		for _, id := range active.messageIDs {
			_, _ = value.store.Update(value.ctx, id, patch(contracts.RawObject{"workId": raw(record.ID), "workKind": raw("task")}))
		}
		return raw(contracts.RawObject{"saved": raw(true), "workId": raw(record.ID), "title": raw(record.Title), "status": raw(record.Status), "plan": raw(record.Plan)}), nil
	case "task_list":
		if len(args) != 0 {
			return nil, workstate.ErrInvalidPlan
		}
		items := []contracts.RawObject{}
		for _, record := range value.store.Snapshot().WorkTasks {
			steps := json.RawMessage("null")
			if record.Plan != nil {
				steps = raw(contracts.RawObject{"completed": raw(record.Plan.Completed), "total": raw(record.Plan.Total)})
			}
			items = append(items, contracts.RawObject{"workId": raw(record.ID), "title": raw(value.redact(record.Title)), "status": raw(record.Status), "steps": steps})
		}
		return raw(contracts.RawObject{"items": raw(items)}), nil
	case "task_cancel":
		if len(args) != 1 {
			return nil, workstate.ErrInvalidPlan
		}
		id := eventString(args, "workId")
		if !workstate.ValidID(id, workstate.IDLength) {
			return nil, workstate.ErrInvalidPlan
		}
		return value.RequestWorkCancellation(ctx, id, owner)
	case "chat_delivery_policy":
		if len(args) != 0 {
			return nil, workstate.ErrInvalidPlan
		}
		value.mu.Lock()
		quiet := value.active != nil && value.active.attemptID != ""
		value.mu.Unlock()
		return raw(contracts.RawObject{"quiet": raw(quiet), "pendingPublication": raw(true), "sent": raw(false)}), nil
	default:
		if value.options.ToolRouter == nil {
			return nil, ErrStaleOwner
		}
		return value.options.ToolRouter.Execute(ctx, name, args, owner)
	}
}
