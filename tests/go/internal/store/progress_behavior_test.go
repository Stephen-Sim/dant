package store

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func progressFixture(t *testing.T) (*Store, *contracts.ChatMessage, contracts.WorkRecord, contracts.Completion) {
	t.Helper()
	s, _ := openFixture(t)
	message := &contracts.ChatMessage{ID: "task", Role: contracts.RoleUser, Text: "fixture request", TurnID: contracts.Some("turn"), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), WorkID: "cae72c16-2a5a-4de5-a26f-ddaf40284791"}
	work := contracts.WorkRecord{ID: "cae72c16-2a5a-4de5-a26f-ddaf40284791", TurnID: "turn", TurnIDs: []string{"turn"}, Source: "chat", Title: "fixture work", MessageID: contracts.Some(message.ID), Status: contracts.WorkStatusCompleted, StartedAt: 100, UpdatedAt: 200, Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "saved result", Status: contracts.PlanStepStatusCompleted}}, Completed: 1, Total: 1}}
	completion := contracts.Completion{ID: "completion", TurnID: "turn", TaskID: contracts.Some(message.ID), MessageIDs: []string{"answer"}, Work: contracts.RawObject{"source": json.RawMessage(`"voice"`), "status": json.RawMessage(`"review"`)}}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages = []*contracts.ChatMessage{message, {ID: "answer", Role: contracts.RoleAssistant, Text: "verified result"}}
		state.WorkTasks = []contracts.WorkRecord{work}
		state.Completions = []contracts.Completion{completion}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return s, message, work, completion
}

func TestProgressPublicOperationsKeepChatAndSavedResults(t *testing.T) {
	for _, candidate := range []ProgressCandidate{{"task", ProgressTask}, {"cae72c16-2a5a-4de5-a26f-ddaf40284791", ProgressWork}, {"completion", ProgressCompletion}} {
		t.Run(string(candidate.Kind), func(t *testing.T) {
			s, _, _, _ := progressFixture(t)
			if raw, err := s.ProgressRecord(candidate.ID, candidate.Kind); err != nil || !json.Valid(raw) {
				t.Fatal("saved progress record unavailable", err)
			}
			if err := s.SetProgressPriority(t.Context(), candidate.ID, candidate.Kind, contracts.TaskPriorityHigh); err != nil {
				t.Fatal(err)
			}
			if err := s.SetProgressPriority(t.Context(), candidate.ID, candidate.Kind, contracts.TaskPriorityHigh); err != nil {
				t.Fatal("same priority was not idempotent", err)
			}
			if err := s.DismissProgress(t.Context(), candidate.ID, candidate.Kind, DismissOptions{ExpectedConversationID: contracts.Some(s.ConversationID()), ExpectedTurnID: contracts.Some("turn")}); err != nil {
				t.Fatal(err)
			}
			if err := s.DismissProgress(t.Context(), candidate.ID, candidate.Kind, DismissOptions{}); err != nil {
				t.Fatal("completed progress dismissal was not idempotent", err)
			}
			state := s.Snapshot()
			entry, err := selectProgress(&state, candidate.ID, candidate.Kind)
			if err != nil || entry.priority().Value != contracts.TaskPriorityHigh || entry.dismissed().Value != s.Timestamp() || len(state.Messages) != 2 || len(state.WorkTasks) != 1 || len(state.Completions) != 1 {
				t.Fatal("hiding progress deleted or changed its saved result", err)
			}
		})
	}
}

func TestProgressRejectsInvalidAmbiguousAndNonfinalSelections(t *testing.T) {
	s, _, _, completion := progressFixture(t)
	for _, candidate := range []ProgressCandidate{{"task", "invalid"}, {"", ProgressTask}, {"missing", ProgressTask}, {"missing", ProgressWork}, {"missing", ProgressCompletion}, {"answer", ProgressTask}} {
		if _, err := s.ProgressRecord(candidate.ID, candidate.Kind); err == nil {
			t.Fatal("invalid progress selection was accepted", candidate)
		}
	}
	if err := s.SetProgressPriority(t.Context(), "task", ProgressTask, "invalid"); err == nil {
		t.Fatal("unknown priority was accepted")
	}
	if err := s.SetProgressPriority(t.Context(), "missing", ProgressTask, contracts.TaskPriorityNormal); err == nil {
		t.Fatal("priority created a missing record")
	}
	for _, options := range []DismissOptions{{ExpectedTurnID: contracts.Some("")}, {ExpectedConversationID: contracts.Null[string]()}, {ExpectedTurnID: contracts.Some("other")}, {ExpectedConversationID: contracts.Some("other")}, {ExpectedTurnID: contracts.Null[string]()}} {
		if err := s.DismissProgress(t.Context(), "task", ProgressTask, options); err == nil {
			t.Fatal("invalid or stale dismissal identity was accepted", options)
		}
	}
	state := s.Snapshot()
	state.Completions = append(state.Completions, completion)
	if _, err := selectProgress(&state, completion.ID, ProgressCompletion); err == nil {
		t.Fatal("ambiguous completion was chosen")
	}
	state.Completions = state.Completions[:1]
	state.Messages[1].Status = contracts.Some(contracts.MessageStatusStreaming)
	if _, err := selectProgress(&state, completion.ID, ProgressCompletion); err == nil {
		t.Fatal("streaming result was treated as final voice history")
	}
	for _, changed := range []contracts.Completion{{TurnID: "turn:input:x"}, {TurnID: "turn:credential:x"}, {TurnID: "turn", Work: contracts.RawObject{"source": json.RawMessage(`"chat"`)}}, {TurnID: "turn", Work: contracts.RawObject{"source": json.RawMessage(`"voice"`), "status": json.RawMessage(`"running"`)}}} {
		if completionWork(&changed) {
			t.Fatal("nonfinal voice history became dismissible")
		}
	}
}

func TestCompletedProgressRequiresConfirmedCurrentExecution(t *testing.T) {
	for _, test := range []struct {
		name     string
		kind     ProgressKind
		mutate   func(*contracts.State)
		complete bool
	}{
		{"message unknown", ProgressTask, func(s *contracts.State) { s.Messages[0].UnknownOutcome = true }, false},
		{"message unfinished", ProgressTask, func(s *contracts.State) {
			s.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
		}, false},
		{"related work unknown", ProgressTask, func(s *contracts.State) { s.WorkTasks[0].UnknownOutcome = true }, false},
		{"work unfinished", ProgressWork, func(s *contracts.State) { s.WorkTasks[0].Status = contracts.WorkStatusPaused }, false},
		{"work related message unknown", ProgressWork, func(s *contracts.State) { s.Messages[0].UnknownOutcome = true }, false},
		{"completion superseded turn", ProgressCompletion, func(s *contracts.State) { s.WorkTasks[0].TurnID = "new-turn" }, false},
		{"completion chat fallback", ProgressCompletion, func(s *contracts.State) { s.WorkTasks = nil }, true},
		{"completion no current evidence", ProgressCompletion, func(s *contracts.State) {
			s.WorkTasks = nil
			s.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
		}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, _, _ := progressFixture(t)
			state := s.Snapshot()
			test.mutate(&state)
			id := map[ProgressKind]string{ProgressTask: "task", ProgressWork: "cae72c16-2a5a-4de5-a26f-ddaf40284791", ProgressCompletion: "completion"}[test.kind]
			entry, err := selectProgress(&state, id, test.kind)
			if err != nil || completedProgress(&state, entry) != test.complete {
				t.Fatal("completion did not retain current confirmed execution", err)
			}
		})
	}
}

func TestProgressConfirmationClearRestoreAndSafeResume(t *testing.T) {
	s, _, _, _ := progressFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
		state.WorkTasks[0].Status = contracts.WorkStatusPaused
		state.WorkTasks[0].ExecutionEndedAt = contracts.Some(float64(1100))
		state.WorkTasks[0].Plan = &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "remaining work", Status: contracts.PlanStepStatusPending}}, Total: 1}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	err := s.DismissProgress(t.Context(), "cae72c16-2a5a-4de5-a26f-ddaf40284791", ProgressWork, DismissOptions{})
	var confirmation *ProgressError
	if !errors.As(err, &confirmation) || !confirmation.ConfirmationNeeded() || !errors.Is(err, confirmation.APIError) {
		t.Fatal("unfinished work did not require explicit confirmation", err)
	}
	if err := s.DismissProgress(t.Context(), "cae72c16-2a5a-4de5-a26f-ddaf40284791", ProgressWork, DismissOptions{ConfirmUnfinished: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreWorkProgress(t.Context(), "task"); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreWorkProgress(t.Context(), "task"); err != nil {
		t.Fatal("visible work restore was not idempotent", err)
	}
	if err := s.RestoreWorkProgress(t.Context(), "missing"); err != nil {
		t.Fatal("missing restore created a record", err)
	}
	resumed, err := s.ResumeWork(t.Context(), "cae72c16-2a5a-4de5-a26f-ddaf40284791", "turn")
	if err != nil || resumed.Status != contracts.WorkStatusContinuing || resumed.Continuation == nil || resumed.Continuation.NextAt.Value != s.Timestamp() {
		t.Fatal("safe resume did not retain durable unfinished work", resumed, err)
	}
	if _, err := s.ResumeWork(t.Context(), "cae72c16-2a5a-4de5-a26f-ddaf40284791", "turn"); err == nil {
		t.Fatal("a continuation was resumed twice")
	}
	if count, err := s.ClearCompletedProgress(t.Context(), []ProgressCandidate{{"task", ProgressTask}, {"missing", ProgressWork}}); err != nil || count != 0 {
		t.Fatal("unfinished task was cleared", count, err)
	}
	completed, _, _, _ := progressFixture(t)
	if count, err := completed.ClearCompletedProgress(t.Context(), []ProgressCandidate{{"task", ProgressTask}, {"cae72c16-2a5a-4de5-a26f-ddaf40284791", ProgressWork}, {"completion", ProgressCompletion}}); err != nil || count != 3 {
		t.Fatal("confirmed completed history was not cleared", count, err)
	}
	if count, err := completed.ClearCompletedProgress(t.Context(), []ProgressCandidate{{"task", ProgressTask}}); err != nil || count != 0 {
		t.Fatal("already hidden history changed again", count, err)
	}
}
