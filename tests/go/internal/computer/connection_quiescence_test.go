package computer

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestIdleConnectionKeepsUnknownHistorySeparateFromLiveActivityAndInstall(t *testing.T) {
	state := contracts.WorkerSnapshot{
		Worker:   contracts.WorkerState{Status: contracts.ConnectionStatusOffline},
		Executor: contracts.ExecutorState{Paused: true},
		Queue:    []string{},
		Messages: []*contracts.ChatMessage{{
			ID: "unknown-history", Role: contracts.RoleUser, UnknownOutcome: true,
			Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
		}},
		WorkTasks: []contracts.WorkRecord{},
		Extra: contracts.RawObject{
			"computer": json.RawMessage(`{"status":"dant","sessionId":null,"pending":false,"acquiring":false}`),
		},
	}
	if !IdleConnectionQuiescent(state) || ServiceUpdateQuiescent(state, true) ||
		!state.Messages[0].UnknownOutcome || state.Executor.ConfirmedStopped {
		t.Fatal("idle recovery changed an unknown task or weakened the install barrier")
	}
	legacy := state
	legacy.Extra = contracts.RawObject{"computer": json.RawMessage(`{"status":"dant","sessionId":null,"expiresAt":0}`)}
	if !IdleConnectionQuiescent(legacy) {
		t.Fatal("an existing Worker control snapshot lost idle connection compatibility")
	}
	recovered := state
	recovered.Worker.Status = contracts.ConnectionStatusOnline
	if !IdleConnectionRecovered(recovered) || IdleConnectionQuiescent(recovered) || IdleConnectionRecovered(state) {
		t.Fatal("executor recovery lost its distinct online postcondition")
	}
	for _, change := range []func(*contracts.WorkerSnapshot){
		func(value *contracts.WorkerSnapshot) { value.Executor.Paused = false },
		func(value *contracts.WorkerSnapshot) { value.Queue = nil },
		func(value *contracts.WorkerSnapshot) { value.Queue = []string{"future-work"} },
		func(value *contracts.WorkerSnapshot) { value.Active = &contracts.ActiveExecution{} },
		func(value *contracts.WorkerSnapshot) { value.Call = &contracts.Call{} },
		func(value *contracts.WorkerSnapshot) { value.Takeover = true },
		func(value *contracts.WorkerSnapshot) { value.Acquiring = true },
		func(value *contracts.WorkerSnapshot) { value.Worker.Status = contracts.ConnectionStatusConnecting },
		func(value *contracts.WorkerSnapshot) { value.Extra = nil },
		func(value *contracts.WorkerSnapshot) {
			value.Extra = contracts.RawObject{
				"computer":                json.RawMessage(`{"status":"dant","sessionId":null}`),
				"executorStopUnconfirmed": json.RawMessage("true"),
			}
		},
		func(value *contracts.WorkerSnapshot) {
			value.Extra = contracts.RawObject{"computer": json.RawMessage(`{"status":"human"}`)}
		},
		func(value *contracts.WorkerSnapshot) {
			value.Extra = contracts.RawObject{"computer": json.RawMessage(`{"status":"dant"}`)}
		},
	} {
		value := state
		change(&value)
		if IdleConnectionQuiescent(value) {
			t.Fatal("unconfirmed live activity authorized an idle connection")
		}
		if value.Worker.Status == contracts.ConnectionStatusOffline {
			value.Worker.Status = contracts.ConnectionStatusOnline
			if IdleConnectionRecovered(value) {
				t.Fatal("recovery claimed an online but unconfirmed admission boundary")
			}
		}
	}
	for _, raw := range []string{
		`{"status":"dant","sessionId":null,"pending":true,"pending":false}`,
		`{"status":"dant","sessionId":null,"acquiring":true,"acquiring":false}`,
		`{"status":"dant","sessionId":null,"pending":null}`,
		`{"status":"dant","sessionId":null,"acquiring":null}`,
		`{"status":"dant","sessionId":null,"pending":"false"}`,
		`null`, `[]`, `{invalid`, strings.Repeat(" ", idleControlMaxBytes+1),
	} {
		value := state
		value.Extra = contracts.RawObject{"computer": json.RawMessage(raw)}
		if IdleConnectionQuiescent(value) {
			t.Fatal("malformed or duplicate control metadata authorized connection recovery")
		}
	}
}
