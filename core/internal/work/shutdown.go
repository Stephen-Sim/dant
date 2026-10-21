package work

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const executorStopFenceKey = "executorStopUnconfirmed"

func (value *Engine) UnconfirmedStop() bool {
	_, present := value.store.Snapshot().Extra[executorStopFenceKey]
	return present
}

// FenceUnconfirmedStop remains available after Close. A stopped API process is
// not proof that its executor stopped; the persisted fence survives a standalone
// restart and is cleared only by ConfirmStopped's independent process proof.
func (value *Engine) FenceUnconfirmedStop(ctx context.Context) error {
	value.mu.Lock()
	defer value.mu.Unlock()

	value.paused = true
	value.confirmedStopped = false
	active := value.active
	if active != nil {
		active.unknown = active.startSubmitted && !active.terminal
		active.stopRequested = true
	}

	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.Extra == nil {
			state.Extra = make(contracts.RawObject)
		}
		state.Extra[executorStopFenceKey] = json.RawMessage("true")

		for _, message := range state.Messages {
			if message.Role != contracts.RoleUser || !unconfirmedShutdownMessage(message) {
				continue
			}
			message.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			message.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			message.UnknownOutcome = true
			message.PauseReason = contracts.Some("executor-stop-unconfirmed")
		}

		for index := range state.WorkTasks {
			record := &state.WorkTasks[index]
			if record.ExecutionEndedAt.Present && !record.ExecutionEndedAt.Null || record.Status == contracts.WorkStatusCompleted || record.Status == contracts.WorkStatusCancelled {
				continue
			}
			record.Status = contracts.WorkStatusUnknown
			record.UnknownOutcome = true
		}
		return nil
	})
	value.changeLocked()
	return err
}

func unconfirmedShutdownMessage(message *contracts.ChatMessage) bool {
	if message.Status.Value == contracts.MessageStatus(contracts.TaskStatusCompleted) || message.Status.Value == contracts.MessageStatus(contracts.TaskStatusCancelled) || message.Status.Value == contracts.MessageStatus(contracts.TaskStatusReview) {
		return false
	}
	return message.Submission.Value == contracts.SubmissionStatusSubmitting || message.Submission.Value == contracts.SubmissionStatusConfirmed || message.Submission.Value == contracts.SubmissionStatusUnknown || message.UnknownOutcome
}

func clearStopFence(state *contracts.State) bool {
	_, present := state.Extra[executorStopFenceKey]
	delete(state.Extra, executorStopFenceKey)
	return present
}
