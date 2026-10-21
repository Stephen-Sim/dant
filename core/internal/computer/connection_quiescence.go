package computer

import (
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const idleControlMaxBytes = 4096

// IdleConnectionQuiescent observes current activity for a paused, explicit
// connection recovery. Durable unknown task outcomes remain untouched. The
// Worker must independently reserve admission and prove its old executor stops.
func IdleConnectionQuiescent(state contracts.WorkerSnapshot) bool {
	if state.Worker.Status != contracts.ConnectionStatusOffline || !state.Executor.Paused ||
		state.Active != nil || state.Call != nil || state.Queue == nil || len(state.Queue) != 0 ||
		state.Takeover || state.Acquiring {
		return false
	}
	object, err := contracts.DecodeObject(state.Extra["computer"], idleControlMaxBytes)
	if err != nil {
		return false
	}
	if _, present := object["sessionId"]; !present {
		return false
	}
	var computer struct {
		Status    contracts.ComputerControlStatus `json:"status"`
		SessionID *string                         `json:"sessionId"`
		Pending   *bool                           `json:"pending"`
		Acquiring *bool                           `json:"acquiring"`
	}
	if json.Unmarshal(state.Extra["computer"], &computer) != nil ||
		computer.Status != contracts.ComputerControlStatusDant ||
		computer.SessionID != nil && *computer.SessionID != "" {
		return false
	}
	// Older Worker snapshots omit these fields. Their connection API still owns
	// the pending/acquisition reservation. Explicit null or unknown values do
	// not become a safe observation when a newer snapshot includes them.
	if _, present := object["pending"]; present && (computer.Pending == nil || *computer.Pending) {
		return false
	}
	if _, present := object["acquiring"]; present && (computer.Acquiring == nil || *computer.Acquiring) {
		return false
	}
	return true
}
