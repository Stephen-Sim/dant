package computer

import (
	"encoding/json"
	"math"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controlObservation struct {
	Status    contracts.ComputerControlStatus `json:"status"`
	SessionID *string                         `json:"sessionId"`
	Pending   bool                            `json:"pending"`
	Acquiring bool                            `json:"acquiring"`
}

func unfinished(status string, ended contracts.Optional[float64]) bool {
	switch status {
	case string(contracts.TaskStatusUnknown), string(contracts.TaskStatusRunning), string(contracts.TaskStatusQueued), string(contracts.TaskStatusAccepted), string(contracts.TaskStatusPausing), string(contracts.TaskStatusContinuing):
		return true
	case string(contracts.TaskStatusWaitingUser):
		value, exists := ended.Get()
		return !exists || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0)
	}

	return false
}

func unconfirmed(unknown bool, submission contracts.Optional[contracts.SubmissionStatus], continuation *contracts.WorkContinuation) bool {
	value, _ := submission.Get()
	return unknown || value == contracts.SubmissionStatusUnknown || value == contracts.SubmissionStatusSubmitting || (continuation != nil && (continuation.Invalid || continuation.Dispatch != nil))
}

// ServiceUpdateQuiescent preserves the existing pause barrier, including durable
// unfinished work. An ended audio response or call never proves a task finished.
func ServiceUpdateQuiescent(state contracts.WorkerSnapshot, allowStopped bool) bool {
	if state.Active != nil || state.Call != nil || state.Queue == nil || len(state.Queue) > 0 || state.Takeover || state.Acquiring || state.Messages == nil || state.WorkTasks == nil {
		return false
	}

	if state.Worker.Status != contracts.ConnectionStatusOnline && !(allowStopped && state.Worker.Status == contracts.ConnectionStatusOffline) {
		return false
	}
	var computer controlObservation
	if json.Unmarshal(state.Extra["computer"], &computer) != nil || computer.Status != contracts.ComputerControlStatusDant || (computer.SessionID != nil && *computer.SessionID != "") || computer.Pending || computer.Acquiring {
		return false
	}
	for _, message := range state.Messages {
		if message == nil || unconfirmed(message.UnknownOutcome, message.Submission, message.Continuation) {
			return false
		}
		status, exists := message.Status.Get()
		if !exists {
			continue
		}
		turnID, _ := message.TurnID.Get()
		if message.Role == contracts.RoleUser && message.WorkKind == "conversation" && message.VoiceCallID != "" && turnID == "" && message.WorkID == "" && string(status) == string(contracts.TaskStatusAccepted) {
			continue
		}
		if unfinished(string(status), message.ExecutionEndedAt) {
			return false
		}
	}
	for _, work := range state.WorkTasks {
		if unconfirmed(work.UnknownOutcome, work.Submission, work.Continuation) || unfinished(string(work.Status), work.ExecutionEndedAt) {
			return false
		}
	}

	return true
}
