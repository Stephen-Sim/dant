package schedules

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func terminal(status string) bool {
	switch contracts.TaskStatus(status) {
	case contracts.TaskStatusReview, contracts.TaskStatusCompleted, contracts.TaskStatusFailed, contracts.TaskStatusCancelled:
		return true
	default:
		return false
	}
}

func terminalReceipt(receipt Receipt) bool {
	return validID(receipt.MessageID) && receipt.TerminalStatus != nil && terminal(*receipt.TerminalStatus) && receipt.TerminalAt != nil && validInstant(*receipt.TerminalAt)
}

func messageStatus(message *contracts.ChatMessage) string {
	if message == nil {
		return ""
	}
	value, _ := message.Status.Get()
	return string(value)
}

func unresolved(submission contracts.Optional[contracts.SubmissionStatus], unknown bool, continuation *contracts.WorkContinuation) bool {
	value, ok := submission.Get()
	return unknown || ok && (value == contracts.SubmissionStatusUnknown || value == contracts.SubmissionStatusSubmitting) || continuation != nil && (continuation.Invalid || continuation.Dispatch != nil)
}

func (s *Scheduler) unfinished(record Record, state contracts.State) bool {
	expected, finished := map[string]bool{}, map[string]bool{}
	if record.MessageID != nil && *record.MessageID != "" {
		expected[*record.MessageID] = true
	}
	for _, receipt := range record.RunHistory {
		if receipt.MessageID != "" {
			expected[receipt.MessageID] = true
		}
		if terminalReceipt(receipt) {
			finished[receipt.MessageID] = true
		}
	}
	messages := []*contracts.ChatMessage{}
	for _, message := range state.Messages {
		if message != nil && (message.ScheduleID == record.ID || expected[message.ID]) {
			messages = append(messages, message)
		}
	}
	for id := range expected {
		found := false
		for _, message := range messages {
			if message.ID == id {
				found = true
			}
		}
		if !finished[id] && !found {
			return true
		}
	}
	ids, turns, works := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for id := range expected {
		ids[id] = true
	}
	for _, receipt := range record.RunHistory {
		if terminalReceipt(receipt) {
			if receipt.TurnID != nil {
				turns[*receipt.TurnID] = true
			}
			if receipt.WorkID != nil {
				works[*receipt.WorkID] = true
			}
		}
	}
	for _, message := range messages {
		ids[message.ID] = true
		if turn, ok := message.TurnID.Get(); ok && turn != "" {
			turns[turn] = true
		}
		if message.WorkID != "" {
			works[message.WorkID] = true
		}
		if !terminal(messageStatus(message)) || unresolved(message.Submission, message.UnknownOutcome, message.Continuation) {
			return true
		}
	}
	for _, provider := range []func() []string{s.options.ActiveIDs, s.options.QueuedIDs} {
		if provider != nil {
			for _, id := range provider() {
				if ids[id] {
					return true
				}
			}
		}
	}
	for _, work := range state.WorkTasks {
		owned := works[work.ID] || turns[work.TurnID]
		if messageID, ok := work.MessageID.Get(); ok && ids[messageID] {
			owned = true
		}
		for _, turn := range work.TurnIDs {
			if turns[turn] {
				owned = true
			}
		}
		if owned && (!terminal(string(work.Status)) || unresolved(work.Submission, work.UnknownOutcome, work.Continuation)) {
			return true
		}
	}
	return false
}

func runHistory(record Record, receipt *Receipt) []Receipt {
	history := []Receipt{}
	indices := map[string]int{}
	for _, run := range record.RunHistory {
		if validID(run.MessageID) {
			if index, ok := indices[run.MessageID]; ok {
				history[index] = run
			} else {
				indices[run.MessageID] = len(history)
				history = append(history, run)
			}
		}
	}
	if record.MessageID != nil {
		run := Receipt{MessageID: *record.MessageID, At: &record.At, DispatchedAt: record.DispatchedAt}
		if record.LastRunAt != nil {
			run.At = record.LastRunAt
		}
		if index, ok := indices[run.MessageID]; ok {
			run = history[index]
			if record.LastRunAt != nil {
				run.At = record.LastRunAt
			} else {
				run.At = &record.At
			}
			run.DispatchedAt = record.DispatchedAt
		}
		if receipt != nil {
			run.TerminalAt = receipt.TerminalAt
			run.TerminalStatus = receipt.TerminalStatus
			run.WorkID = receipt.WorkID
			run.TurnID = receipt.TurnID
		}
		if index, ok := indices[run.MessageID]; ok {
			history[index] = run
		} else {
			history = append(history, run)
		}
	}
	if len(history) > RunHistoryLimit {
		history = history[len(history)-RunHistoryLimit:]
	}
	return history
}

func (s *Scheduler) rememberFinished(ctx context.Context, snapshot Snapshot) (Snapshot, error) {
	state := s.store.Snapshot()
	changed := false
	items := append([]Record{}, snapshot.Items...)
	for index, item := range items {
		if item.MessageID == nil {
			continue
		}
		remembered := false
		for _, receipt := range item.RunHistory {
			if receipt.MessageID == *item.MessageID && terminalReceipt(receipt) {
				remembered = true
			}
		}
		if remembered {
			continue
		}
		for _, message := range state.Messages {
			if message == nil || message.ID != *item.MessageID || !terminal(messageStatus(message)) || s.unfinished(item, state) {
				continue
			}
			status, now := messageStatus(message), float64(s.options.Now().UnixMilli())
			receipt := Receipt{TerminalStatus: &status, TerminalAt: &now}
			if validID(message.WorkID) {
				receipt.WorkID = &message.WorkID
			}
			if turn, ok := message.TurnID.Get(); ok && validID(turn) {
				receipt.TurnID = &turn
			}
			items[index].RunHistory = runHistory(item, &receipt)
			changed = true
			break
		}
	}
	if !changed {
		return snapshot, nil
	}
	if err := s.database.Replace(ctx, snapshot.Revision, items, snapshot.DeletedRequestIDs, nil); err != nil {
		return snapshot, err
	}
	s.changed()
	return s.refresh(ctx)
}

// Tick commits the no-replay SQLite fence before crossing Engine admission.
// An unconfirmed handoff is retained for reconciliation, never resubmitted.
func (s *Scheduler) Tick(ctx context.Context) ([]json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dispatched := []json.RawMessage{}
	if !s.available() {
		return dispatched, nil
	}
	snapshot, err := s.refresh(ctx)
	if err != nil {
		return nil, err
	}
	snapshot, err = s.rememberFinished(ctx, snapshot)
	if err != nil {
		return nil, err
	}
	for _, candidate := range sortedRecords(snapshot.Items) {
		if !s.available() {
			break
		}
		current, err := s.refresh(ctx)
		if err != nil {
			return dispatched, err
		}
		saved, ok := findRecord(current.Items, candidate.ID)
		before, _ := json.Marshal(candidate)
		latest, _ := json.Marshal(saved)
		now := float64(s.options.Now().UnixMilli())
		if !ok || string(before) != string(latest) || !validID(saved.ID) || strings.ContainsRune(saved.Text, 0) || saved.Status != contracts.ScheduleStatusPending || saved.Enabled != nil && !*saved.Enabled || !validInstant(saved.At) || saved.At > now || trim(saved.Text) == "" {
			continue
		}
		if s.unfinished(saved, s.store.Snapshot()) {
			continue
		}
		next := int64(0)
		if cron, ok := saved.Cron.Get(); ok {
			next, err = NextAt(cron, int64(now), recordZone(saved))
			if err != nil {
				continue
			}
		}
		if !priority(saved).Valid() {
			continue
		}
		id := s.options.NewID()
		if !validID(id) {
			return dispatched, ErrInvalid
		}
		claimed := saved
		claimed.Status = contracts.ScheduleStatusDispatched
		enabled := next > 0
		claimed.Enabled = &enabled
		if next > 0 {
			claimed.Status = contracts.ScheduleStatusPending
			claimed.At = float64(next)
		}
		claimed.LastRunAt = &saved.At
		claimed.MessageID = &id
		claimed.DispatchedAt = &now
		claimed.UpdatedAt = &now
		if saved.MessageID != nil {
			claimed.RunHistory = runHistory(saved, nil)
		}
		message := ScheduledMessage{id, contracts.RoleUser, saved.Text, contracts.TaskStatusQueued, true, saved.ID, int64(saved.At), priority(saved)}
		accepted, err := s.database.Claim(ctx, Claim{current.Revision, saved, claimed, message, s.owner})
		if err != nil {
			return dispatched, err
		}
		if !accepted {
			continue
		}
		if _, err = s.refresh(ctx); err != nil {
			return dispatched, err
		}
		var materialized *contracts.ChatMessage
		ok, err = s.database.Materialize(ctx, id, s.owner, func(dispatch Dispatch) error {
			var err error
			materialized, err = s.store.MaterializeScheduledMessage(ctx, dispatch.Message.Chat(), false)
			return err
		})
		if err != nil {
			return dispatched, err
		}
		if !ok || materialized == nil {
			continue
		}
		submission, submissionPresent := materialized.Submission.Get()
		turn, turnPresent := materialized.TurnID.Get()
		confirmed, confirmedPresent := materialized.ExecutorConfirmedAt.Get()
		if messageStatus(materialized) != string(contracts.TaskStatusQueued) || materialized.UnknownOutcome || turnPresent && turn != "" || submissionPresent && submission != contracts.SubmissionStatusNotSubmitted || confirmedPresent && confirmed > 0 {
			if _, err = s.reconcile(ctx); err != nil {
				return dispatched, err
			}
			continue
		}
		fenced, err := s.database.FenceHandoff(ctx, id, s.owner)
		if err != nil {
			return dispatched, err
		}
		if !fenced {
			continue
		}
		if err = s.options.Enqueue(ctx, materialized); err != nil {
			return dispatched, err
		}
		view, err := present(claimed, s.store.Snapshot())
		if err != nil {
			return dispatched, err
		}
		dispatched = append(dispatched, view)
	}
	return dispatched, nil
}
