package work

import (
	"context"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func (value *Engine) progressOwnedLocked(id string, kind store.ProgressKind, state contracts.State) bool {
	turn, workID := "", ""
	ids := []string{id}
	switch kind {
	case store.ProgressTask:
		message, err := store.FindMessage(&state, id)
		if err != nil {
			return false
		}
		turn, workID = message.TurnID.Value, message.WorkID
		if call := value.CallSnapshot(); call != nil && message.VoiceCallID == call.ID && (message.Submission.Value == contracts.SubmissionStatusSubmitting || message.Submission.Value == contracts.SubmissionStatusPreparing) {
			return true
		}
	case store.ProgressWork:
		record, err := store.FindWork(&state, id)
		if err != nil {
			return false
		}
		turn, workID = record.TurnID, record.ID
		ids = append(ids, record.MessageID.Value)
	case store.ProgressCompletion:
		for _, entry := range state.Completions {
			if entry.ID == id {
				turn = entry.TurnID
				ids = append(ids, entry.TaskID.Value)
				ids = append(ids, entry.MessageIDs...)
			}
		}
	}
	for _, queued := range value.queue {
		if slices.Contains(ids, queued) {
			return true
		}
		if message, err := store.FindMessage(&state, queued); err == nil && (turn != "" && message.TurnID.Value == turn || workID != "" && message.WorkReply != nil && message.WorkReply.WorkID == workID) {
			return true
		}
	}
	for pending := range value.pendingFollowups {
		if slices.Contains(ids, pending) {
			return true
		}
		if message, err := store.FindMessage(&state, pending); err == nil && turn != "" && message.TurnID.Value == turn {
			return true
		}
	}
	active := value.active
	if active == nil {
		return false
	}
	return turn != "" && active.turnID == turn || workID != "" && active.workID == workID || slices.ContainsFunc(ids, func(id string) bool { return id != "" && slices.Contains(active.messageIDs, id) })
}

func (value *Engine) DismissProgress(ctx context.Context, id string, kind store.ProgressKind, options store.DismissOptions) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance || value.progressOwnedLocked(id, kind, value.store.Snapshot()) {
		return ErrBusy
	}
	if err := value.store.DismissProgress(ctx, id, kind, options); err != nil {
		return err
	}
	value.changeLocked()
	return nil
}

func (value *Engine) ResumeProgress(ctx context.Context, id string, kind store.ProgressKind, turnID string) (*contracts.WorkRecord, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	state := value.store.Snapshot()
	if kind != store.ProgressWork || value.closed || value.maintenance || value.takeover || value.acquiring || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline || value.progressOwnedLocked(id, kind, state) {
		return nil, ErrBusy
	}
	record, err := value.store.ResumeWork(ctx, id, turnID)
	if err != nil {
		return nil, err
	}
	value.paused = false
	value.changeLocked()
	return record, nil
}

func (value *Engine) ClearCompletedProgress(ctx context.Context) (int, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance {
		return 0, ErrBusy
	}
	state := value.store.Snapshot()
	candidates := []store.ProgressCandidate{}
	for _, message := range state.Messages {
		if message.Role == contracts.RoleUser && !value.progressOwnedLocked(message.ID, store.ProgressTask, state) {
			candidates = append(candidates, store.ProgressCandidate{ID: message.ID, Kind: store.ProgressTask})
		}
	}
	for _, record := range state.WorkTasks {
		if !value.progressOwnedLocked(record.ID, store.ProgressWork, state) {
			candidates = append(candidates, store.ProgressCandidate{ID: record.ID, Kind: store.ProgressWork})
		}
	}
	for _, entry := range state.Completions {
		if !value.progressOwnedLocked(entry.ID, store.ProgressCompletion, state) {
			candidates = append(candidates, store.ProgressCandidate{ID: entry.ID, Kind: store.ProgressCompletion})
		}
	}
	count, err := value.store.ClearCompletedProgress(ctx, candidates)
	if err == nil && count > 0 {
		value.changeLocked()
	}
	return count, err
}

func (value *Engine) Confirm(ctx context.Context, id string) (*contracts.ChatMessage, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance || value.progressOwnedLocked(id, store.ProgressTask, value.store.Snapshot()) {
		return nil, ErrBusy
	}
	message, err := value.store.Confirm(ctx, id)
	if err == nil {
		value.changeLocked()
	}
	return message, err
}

func (value *Engine) SetProgressPriority(ctx context.Context, id string, kind store.ProgressKind, priority contracts.TaskPriority) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance {
		return runtime.ErrBackpressure
	}
	if err := value.store.SetProgressPriority(ctx, id, kind, priority); err != nil {
		return err
	}
	value.changeLocked()
	return nil
}
