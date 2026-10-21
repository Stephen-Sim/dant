package store

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestProgressDismissalRejectsMissingActiveAndNonfinalVoiceRecords(t *testing.T) {
	s, _, _, _ := progressFixture(t)
	if err := s.DismissProgress(t.Context(), "missing", ProgressTask, DismissOptions{}); err == nil {
		t.Fatal("dismissal created a missing task")
	}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusRunning))
		state.Completions[0].Work["source"] = json.RawMessage(`"chat"`)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before := s.Revision()
	if err := s.DismissProgress(t.Context(), "task", ProgressTask, DismissOptions{ConfirmUnfinished: true}); err == nil {
		t.Fatal("explicit confirmation hid actively executing work")
	}
	if err := s.DismissProgress(t.Context(), "completion", ProgressCompletion, DismissOptions{ConfirmUnfinished: true}); err == nil {
		t.Fatal("nonfinal voice metadata became dismissible task history")
	}
	if s.Revision() != before || s.Snapshot().Messages[0].ProgressDismissedAt.Value != 0 {
		t.Fatal("rejected dismissal changed durable progress")
	}
}

func TestResumeKeepsAttemptHistoryAndWaitsForRelatedSubmissionReconciliation(t *testing.T) {
	s, _, record, _ := progressFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		current := &state.WorkTasks[0]
		current.Status = contracts.WorkStatusPaused
		current.ExecutionEndedAt = contracts.Some(float64(1100))
		current.Plan = &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Synthetic remaining work", Status: contracts.PlanStepStatusPending}}}
		current.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), Attempts: 4, LastCheckpoint: workstate.Checkpoint(current.Plan)}
		state.Messages[0].Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before := s.Revision()
	if _, err := s.ResumeWork(t.Context(), record.ID, record.TurnID); err == nil || s.Revision() != before {
		t.Fatal("unreconciled related submission became safe to resume", err)
	}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Submission = contracts.Some(contracts.SubmissionStatusNotSubmitted)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	resumed, err := s.ResumeWork(t.Context(), record.ID, record.TurnID)
	if err != nil || resumed.Continuation.Attempts != 4 || resumed.Status != contracts.WorkStatusContinuing || resumed.TurnID != record.TurnID {
		t.Fatal("explicit safe resume discarded its attempt history or changed its execution identity", err)
	}
}

func TestContinuationClaimsRejectDuplicateAttemptsAndExhaustedCounters(t *testing.T) {
	for _, exhausted := range []bool{false, true} {
		t.Run(map[bool]string{false: "duplicate attempt", true: "exhausted attempts"}[exhausted], func(t *testing.T) {
			s, record := continuationTransitionFixture(t)
			if exhausted {
				if err := s.Mutate(t.Context(), func(state *contracts.State) error {
					state.WorkTasks[0].Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(float64(1000)), Attempts: 9_007_199_254_740_991, LastCheckpoint: workstate.Checkpoint(state.WorkTasks[0].Plan)}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			} else {
				claimed := claimTransitionFixture(t, s, record)
				if claimed.Continuation.Dispatch.ID != "transition-attempt" {
					t.Fatal("fixture claim lost its retained attempt")
				}
				second, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "second-previous-turn", Source: "chat", Title: "Synthetic second work", Plan: record.Plan})
				if err != nil {
					t.Fatal(err)
				}
				record, err = s.UpdateRegisteredWork(t.Context(), second.TurnID, UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true, At: 1000})
				if err != nil {
					t.Fatal(err)
				}
			}
			before := s.Revision()
			_, err := s.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: "transition-attempt", RuntimeID: "vm:isolated", ThreadID: "isolated-thread"})
			if err == nil || s.Revision() != before {
				t.Fatal("unsafe claim allocated a new dispatch identity", err)
			}
		})
	}
}

func TestContinuationBindingCannotAdoptAnotherWorksAcknowledgedTurn(t *testing.T) {
	s, record := continuationTransitionFixture(t)
	claimTransitionFixture(t, s, record)
	before := s.Revision()
	if _, err := s.UpdateRegisteredWork(t.Context(), record.TurnID, UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusReview)}); err == nil || s.Revision() != before {
		t.Fatal("unsubmitted continuation claim was completed by its previous execution", err)
	}
	if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, "transition-attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		t.Fatal(err)
	}
	other, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "already-owned-turn", Source: "chat", Title: "Synthetic independent work", Plan: record.Plan})
	if err != nil {
		t.Fatal(err)
	}
	before = s.Revision()
	if _, err := s.BindWorkContinuation(t.Context(), record.ID, "transition-attempt", other.TurnID); err == nil || s.Revision() != before {
		t.Fatal("continuation adopted a turn already owned by another work record", err)
	}
	if _, err := s.FinishUnboundWorkContinuation(t.Context(), record.ID, "transition-attempt", other.TurnID, contracts.WorkStatusPaused, 20000); err == nil || s.Revision() != before {
		t.Fatal("failed acknowledgement repair adopted another work's turn", err)
	}
	state := s.Snapshot()
	retained, err := FindWork(&state, record.ID)
	if err != nil || retained.TurnID != record.TurnID || retained.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseSubmitting {
		t.Fatal("rejected binding changed the unresolved submission", err)
	}
}

func TestRestoredWorkDefaultsOnlyItsUnknownDisplayPriority(t *testing.T) {
	_, record := continuationTransitionFixture(t)
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := contracts.DecodeObject(raw, len(raw))
	if err != nil {
		t.Fatal(err)
	}
	fields["progressPriority"] = json.RawMessage(`"future-display-priority"`)
	raw, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := restoreWorkRecord(raw, false)
	if err != nil || restored.ProgressPriority.Value != contracts.TaskPriorityNormal || restored.Status != record.Status || restored.TurnID != record.TurnID {
		t.Fatal("display-priority compatibility changed durable execution state", err)
	}
}

func TestMessageCreationAllocatesOnlyMissingIDsAndRejectsUnrepresentableLegacyFields(t *testing.T) {
	s, _ := openFixture(t)
	message, err := s.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic authored message"})
	if err != nil || message.ID == "" {
		t.Fatal("message creation did not allocate its local identity", err)
	}
	before := s.Revision()
	if _, err := s.Add(t.Context(), message); !errors.Is(err, ErrMessageConflict) || s.Revision() != before {
		t.Fatal("duplicate message creation replaced existing history", err)
	}
	for _, patch := range []contracts.MessagePatch{{"text": json.RawMessage(`false`)}, {"future": json.RawMessage(`{`)}} {
		if _, err := s.Update(t.Context(), message.ID, patch); !errors.Is(err, ErrInvalidState) || s.Revision() != before {
			t.Fatal("invalid message update changed persisted history", err)
		}
	}
	invalid := &contracts.ChatMessage{ID: "legacy-invalid", Role: contracts.RoleUser, Text: "Synthetic text", LegacyText: contracts.LegacyJSON{Original: contracts.RawObject{"text": json.RawMessage(`17`)}, Decoded: map[string]string{"text": "Synthetic text"}}}
	if _, err := s.Add(t.Context(), invalid); !errors.Is(err, ErrInvalidState) || s.Revision() != before {
		t.Fatal("unrepresentable legacy message changed persisted history", err)
	}
}

func TestAmbiguousStoredMessageIDsCannotChooseOrMaterializeOneArbitrarily(t *testing.T) {
	s, _ := openFixture(t)
	input := &contracts.ChatMessage{ID: "duplicate-message", Role: contracts.RoleUser, Text: "Synthetic scheduled request", Scheduled: true, ScheduleID: "isolated-schedule", ScheduledAt: contracts.Some(float64(1000)), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))}
	if _, err := s.MaterializeScheduledMessage(t.Context(), input, false); err != nil {
		t.Fatal(err)
	}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		duplicate := *state.Messages[0]
		state.Messages = append(state.Messages, &duplicate)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before := s.Revision()
	if _, err := s.Message(input.ID); !errors.Is(err, ErrMessageConflict) {
		t.Fatal("ambiguous saved identity selected an arbitrary message", err)
	}
	if _, err := s.Update(t.Context(), input.ID, contracts.MessagePatch{"text": json.RawMessage(`"Must not select an arbitrary duplicate"`)}); !errors.Is(err, ErrMessageConflict) {
		t.Fatal("ambiguous saved identity allowed an arbitrary update", err)
	}
	if _, err := s.MaterializeScheduledMessage(t.Context(), input, false); !errors.Is(err, ErrMessageConflict) {
		t.Fatal("ambiguous scheduled identity became a newly materialized action", err)
	}
	if s.Revision() != before || len(s.Snapshot().Messages) != 2 {
		t.Fatal("rejected ambiguous identity changed persisted history")
	}
}

func TestRestartPausesUnfinishedHumanInputsWithoutInventingExecutionConfirmation(t *testing.T) {
	for _, status := range []contracts.TaskStatus{contracts.TaskStatusQueued, contracts.TaskStatusRunning, contracts.TaskStatusWaitingUser, contracts.TaskStatusPausing, contracts.TaskStatusInterrupted} {
		t.Run(string(status), func(t *testing.T) {
			raw, err := json.Marshal(&contracts.ChatMessage{ID: "isolated-request", Role: contracts.RoleUser, Text: "Synthetic unfinished input", Status: contracts.Some(contracts.MessageStatus(status))})
			if err != nil {
				t.Fatal(err)
			}
			message, err := restoreMessage(raw, true)
			if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || message.PauseReason.Value != "restart" || !message.ExecutorConfirmedAt.Null {
				t.Fatal("restart made unfinished input executable or invented its acknowledgement", err)
			}
		})
	}
}

func TestContinuationRejectsInvalidRuntimeAndTerminalAcknowledgementMetadata(t *testing.T) {
	s, record := continuationTransitionFixture(t)
	before := s.Revision()
	if _, err := s.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{ExpectedTurnID: record.TurnID, AttemptID: "isolated-attempt", ThreadID: "isolated-thread", RuntimeID: "invalid\nruntime"}); err == nil || s.Revision() != before {
		t.Fatal("malformed executor identity acquired a durable claim", err)
	}
	claimTransitionFixture(t, s, record)
	if _, err := s.SetWorkContinuationPhase(t.Context(), record.ID, "transition-attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		t.Fatal(err)
	}
	bound, err := s.BindWorkContinuation(t.Context(), record.ID, "transition-attempt", "observed-turn")
	if err != nil {
		t.Fatal(err)
	}
	before = s.Revision()
	if _, err := s.UpdateRegisteredWork(t.Context(), bound.TurnID, UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusRunning), ExecutionEnded: true}); err == nil || s.Revision() != before {
		t.Fatal("ended execution retained a running dispatch state", err)
	}
	updated, err := s.UpdateRegisteredWork(t.Context(), bound.TurnID, UpdateRegisteredWorkOptions{Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Synthetic completed observation", Status: contracts.PlanStepStatusCompleted}, {Step: "Synthetic remaining verification", Status: contracts.PlanStepStatusPending}}}})
	if err != nil || updated.Plan.Completed != 1 || updated.Plan.Total != 2 || updated.TurnID != bound.TurnID {
		t.Fatal("valid plan update changed acknowledged execution ownership", err)
	}
}
