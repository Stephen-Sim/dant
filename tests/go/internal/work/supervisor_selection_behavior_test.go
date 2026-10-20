package work

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestSupervisorSelectsEligibleWorkByPriorityThenDueTimeWithoutExecutingFutureWork(t *testing.T) {
	persistence, err := store.Open(t.TempDir(), store.Options{Now: func() time.Time { return time.UnixMilli(20000) }})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	ids := map[string]string{}
	for _, fixture := range []struct {
		name     string
		priority contracts.TaskPriority
		ended    float64
	}{
		{"low", contracts.TaskPriorityLow, 1000},
		{"normal", contracts.TaskPriorityNormal, 1000},
		{"high-later", contracts.TaskPriorityHigh, 2000},
		{"high-earlier", contracts.TaskPriorityHigh, 1000},
		{"future", contracts.TaskPriorityHigh, 30000},
	} {
		record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{
			TurnID: fixture.name + "-turn", Source: "chat", Title: fixture.name, Observed: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := persistence.UpdateRegisteredWork(t.Context(), record.TurnID, store.UpdateRegisteredWorkOptions{
			Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true, At: fixture.ended,
		}); err != nil {
			t.Fatal(err)
		}
		if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
			current, err := store.FindWork(state, record.ID)
			if err == nil {
				current.ProgressPriority = contracts.Some(fixture.priority)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		ids[fixture.name] = record.ID
	}
	selected := []string{}
	engine := &supervisorBehaviorEngine{available: true, changes: make(chan struct{})}
	engine.continueWork = func(ctx context.Context, id string, owner ContinueOptions) (json.RawMessage, error) {
		selected = append(selected, id)
		_, err := persistence.UpdateRegisteredWork(ctx, owner.ExpectedTurnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusPaused)})
		return nil, err
	}
	supervisor, err := NewSupervisor(t.Context(), engine, persistence, SupervisorOptions{Now: func() time.Time { return time.UnixMilli(20000) }})
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close(context.Background())
	for index, name := range []string{"high-earlier", "high-later", "normal", "low"} {
		if _, err := supervisor.Tick(t.Context()); err != nil || len(selected) != index+1 || selected[index] != ids[name] {
			t.Fatal("supervisor chose work outside priority/due order", name, err)
		}
	}
	if _, err := supervisor.Tick(t.Context()); err != nil || len(selected) != 4 {
		t.Fatal("future work bypassed its saved deadline", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := supervisor.Tick(cancelled); err != context.Canceled || len(selected) != 4 {
		t.Fatal("cancelled tick admitted new work", err)
	}
}

func TestSupervisorFailureNoticeRecognizesOnlyAProvenAliasOfTheSelectedTurn(t *testing.T) {
	for _, aliased := range []bool{false, true} {
		t.Run(map[bool]string{false: "unrelated-turn", true: "retained-alias"}[aliased], func(t *testing.T) {
			persistence, err := store.Open(t.TempDir(), store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer persistence.Close()
			id, previous := savedUnfinished(t, persistence)
			engine := &supervisorBehaviorEngine{available: true, changes: make(chan struct{})}
			engine.continueWork = func(ctx context.Context, selected string, options ContinueOptions) (json.RawMessage, error) {
				if selected != id || options.ExpectedTurnID != previous {
					t.Fatal("supervisor lost the selected task identity")
				}
				if err := persistence.Mutate(ctx, func(state *contracts.State) error {
					record, err := store.FindWork(state, id)
					if err != nil {
						return err
					}
					record.TurnID = "newly-observed-turn"
					record.TurnIDs = []string{record.TurnID}
					if aliased {
						record.TurnIDs = append(record.TurnIDs, previous)
					}
					record.Status = contracts.WorkStatusUnknown
					return nil
				}); err != nil {
					return nil, err
				}
				return nil, ErrUnknown
			}
			notices := 0
			supervisor, err := NewSupervisor(t.Context(), engine, persistence, SupervisorOptions{Notice: func(string) { notices++ }})
			if err != nil {
				t.Fatal(err)
			}
			defer supervisor.Close(context.Background())
			if _, err := supervisor.Tick(t.Context()); err != ErrUnknown || (notices == 1) != aliased {
				t.Fatal("failure notice was associated with an unrelated replacement turn", err)
			}
			if _, err := supervisor.Tick(t.Context()); err != nil || notices > 1 {
				t.Fatal("unreconciled failed handoff was retried or repeatedly announced", err)
			}
		})
	}
}
