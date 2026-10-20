package work

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type supervisorEngineFixture struct {
	available func() bool
	continued []ContinueOptions
	ids       []string
}

func (fixture *supervisorEngineFixture) CanContinueRegisteredWork() bool { return fixture.available() }
func (fixture *supervisorEngineFixture) ContinueRegisteredWork(_ context.Context, id string, options ContinueOptions) (json.RawMessage, error) {
	fixture.ids = append(fixture.ids, id)
	fixture.continued = append(fixture.continued, options)
	return json.RawMessage(`{"continued":true}`), nil
}

func (*supervisorEngineFixture) Subscribe() (<-chan struct{}, func()) {
	return make(chan struct{}), func() {}
}

func TestSupervisorRechecksDurableTurnBeforeItsOneEngineAdmission(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	checks := 0
	fixture := &supervisorEngineFixture{available: func() bool {
		checks++
		if checks == 2 {
			if err := persistence.Mutate(context.Background(), func(state *contracts.State) error { state.WorkTasks[0].TurnID = "replacement-turn"; return nil }); err != nil {
				t.Fatal(err)
			}
		}
		return true
	}}
	supervisor, err := NewSupervisor(context.Background(), fixture, persistence, SupervisorOptions{Now: func() time.Time { return time.UnixMilli(100_000) }})
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close(context.Background())
	if _, err := supervisor.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fixture.ids) != 0 {
		t.Fatal("stale timer candidate admitted a replacement turn")
	}
	fixture.available = func() bool { return true }
	if _, err := supervisor.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fixture.ids) != 1 || fixture.ids[0] != workID || fixture.continued[0].ExpectedTurnID == fromTurn {
		t.Fatal("timer failed to recapture the exact current turn")
	}
	if engine.Snapshot().Active != nil {
		t.Fatal("supervisor fixture secretly acquired a second executor")
	}
}
