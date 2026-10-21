package store

import (
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestWorkRestoreUsesTheSameRetentionBoundAsNewWorkRegistration(t *testing.T) {
	directory := t.TempDir()
	persistence, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	ids := make([]string, MaxWorkRecords+1)
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
		for index := range ids {
			ids[index] = UUID()
			turn := fmt.Sprintf("preserved-work-turn-%d", index)
			state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{
				ID: ids[index], TurnID: turn, TurnIDs: []string{turn}, Title: "preserved completed work",
				Status: contracts.WorkStatusCompleted, Source: "chat", StartedAt: 1000, UpdatedAt: 2000,
				Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "verified saved result", Status: contracts.PlanStepStatusCompleted}}, Completed: 1, Total: 1},
			})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	persistence.Close()
	reopened, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	records := reopened.Snapshot().WorkTasks
	if len(records) != 300 || records[0].ID != ids[1] || records[len(records)-1].ID != ids[len(ids)-1] {
		t.Fatal("reopen changed the work retention capacity or discarded the newest records")
	}
}
