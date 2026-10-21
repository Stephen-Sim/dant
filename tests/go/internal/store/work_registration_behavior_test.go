package store

import (
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRegisterExplicitWorkSupersedesOnlyItsProvisionalTurnAndRetainsPriorIdentity(t *testing.T) {
	for _, automaticFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "automatic after", true: "automatic before"}[automaticFirst], func(t *testing.T) {
			s, _, previous, _ := progressFixture(t)
			previous.Status = contracts.WorkStatusPaused
			previous.Plan.Steps[0].Status = contracts.PlanStepStatusPending
			previous.Plan.Completed = 0
			automatic := contracts.WorkRecord{ID: "8eb16bb7-ecac-47e9-b2b2-d01e57cd97f4", TurnID: "new-turn", TurnIDs: []string{"new-turn"}, Source: "chat", Title: "Observed automatic work", Provisional: true, Status: contracts.WorkStatusRunning}
			if err := s.Mutate(t.Context(), func(state *contracts.State) error {
				state.WorkTasks = []contracts.WorkRecord{previous, automatic}
				if automaticFirst {
					state.WorkTasks = []contracts.WorkRecord{automatic, previous}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			record, err := s.RegisterWork(t.Context(), RegisterWorkOptions{WorkID: previous.ID, TurnID: automatic.TurnID, Source: "chat", Title: "Explicit authored plan", Plan: previous.Plan})
			if err != nil || record.ID != previous.ID || record.Title != "Explicit authored plan" || record.TurnID != automatic.TurnID || len(record.TurnIDs) != 2 || record.TurnIDs[0] != "turn" || record.TurnIDs[1] != "new-turn" || len(s.Snapshot().WorkTasks) != 1 {
				t.Fatal("explicit registration discarded exact previous ownership or kept a duplicate provisional task", err)
			}
		})
	}
}

func TestObservedWorkKeepsTheExistingPlanAndInheritedMessagePriority(t *testing.T) {
	s, message, previous, _ := progressFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].ProgressPriority = contracts.Some(contracts.TaskPriorityHigh)
		state.WorkTasks = nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	record, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "new-turn", Source: "chat", MessageID: message.ID, Title: "Original authored title", Plan: previous.Plan, StartedAt: 500, Status: contracts.WorkStatusWaitingUser})
	if err != nil || record.StartedAt != 500 || record.MessageID.Value != message.ID || record.ProgressPriority.Value != contracts.TaskPriorityHigh || record.Status != contracts.WorkStatusWaitingUser {
		t.Fatal("work did not inherit validated source metadata", err)
	}
	observed, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "new-turn", Source: "chat", Title: "Observer text cannot replace the plan", Observed: true})
	if err != nil || observed.ID != record.ID || observed.Title != record.Title || observed.Plan == nil || observed.Plan.Steps[0].Step != record.Plan.Steps[0].Step || observed.Provisional {
		t.Fatal("observer replaced the authored plan or allocated another task", err)
	}
}

func TestWorkRegistrationRejectsAnotherOwnedTurnAndAmbiguousWorkIdentity(t *testing.T) {
	for _, kind := range []string{"nonprovisional current", "historical owner", "unconfirmed previous"} {
		t.Run(kind, func(t *testing.T) {
			s, _, previous, _ := progressFixture(t)
			input := RegisterWorkOptions{WorkID: previous.ID, TurnID: "new-turn", Source: "chat", Title: "Explicit plan", Plan: previous.Plan}
			if err := s.Mutate(t.Context(), func(state *contracts.State) error {
				state.WorkTasks[0].Status = contracts.WorkStatusPaused
				switch kind {
				case "nonprovisional current":
					other := previous
					other.ID, other.TurnID, other.TurnIDs = "8eb16bb7-ecac-47e9-b2b2-d01e57cd97f4", "new-turn", []string{"new-turn"}
					state.WorkTasks = append(state.WorkTasks, other)
				case "historical owner":
					state.WorkTasks[0].TurnIDs = append(state.WorkTasks[0].TurnIDs, "new-turn")
					input.WorkID = ""
				case "unconfirmed previous":
					state.WorkTasks[0].Continuation = &contracts.WorkContinuation{}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.RegisterWork(t.Context(), input); err == nil {
				t.Fatal("work registration reused a conflicting execution owner", kind)
			}
		})
	}
	state := contracts.State{WorkTasks: []contracts.WorkRecord{{ID: "duplicate"}, {ID: "duplicate"}}}
	if _, err := FindWork(&state, "duplicate"); err != ErrMessageConflict {
		t.Fatal("ambiguous work identity selected a record", err)
	}
}

func TestWorkAndCompletionRetentionKeepTheNewestRecordAndDeduplicateTheSameTurn(t *testing.T) {
	s, _ := openFixture(t)
	plan := &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Keep latest result", Status: contracts.PlanStepStatusPending}}, Total: 1}
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		for index := range MaxWorkRecords {
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", index+10)
			turn := fmt.Sprintf("turn-%d", index)
			state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{ID: id, TurnID: turn, TurnIDs: []string{turn}, Source: "chat", Title: "Old result", Status: contracts.WorkStatusCompleted, Plan: plan})
			state.Completions = append(state.Completions, contracts.Completion{ID: id, TurnID: turn})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	record, err := s.RegisterWork(t.Context(), RegisterWorkOptions{TurnID: "latest-turn", Source: "chat", Title: "Latest request", Plan: plan})
	if err != nil || record.TurnID != "latest-turn" || len(s.Snapshot().WorkTasks) != MaxWorkRecords || s.Snapshot().WorkTasks[0].TurnID != "turn-1" {
		t.Fatal("work retention lost the new record or retained its oldest entry", err)
	}
	ids := []string{"saved-result"}
	completion, err := s.AddCompletion(t.Context(), "latest-turn", ids, contracts.Some("task"), contracts.RawObject{})
	if err != nil || len(s.Snapshot().Completions) != MaxWorkRecords || s.Snapshot().Completions[0].TurnID != "turn-1" || completion.MessageIDs[0] != "saved-result" {
		t.Fatal("completion retention lost a saved result", err)
	}
	ids[0] = "changed caller slice"
	again, err := s.AddCompletion(t.Context(), "latest-turn", []string{"another-result"}, contracts.Null[string](), nil)
	if err != nil || again.ID != completion.ID || again.MessageIDs[0] != "saved-result" || len(s.Snapshot().Completions) != MaxWorkRecords {
		t.Fatal("duplicate terminal receipt replaced its saved output or retained caller-owned data", err)
	}
}
