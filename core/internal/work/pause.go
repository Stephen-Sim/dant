package work

import (
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const (
	pauseReasonUser          = "user-paused"
	pauseReasonHumanControl  = "human-control"
	pauseReasonVoiceCall     = "voice-call"
	pauseReasonDisconnected  = "executor-disconnected"
	pauseReasonUnknown       = "submission-unknown"
	pauseReasonContinuation  = "continuation-unconfirmed"
	pauseReasonStopUnknown   = "executor-stop-unconfirmed"
	pauseReasonRequestFailed = "executor_request_failed"
)

// Preserve the first safety stop until an explicit human pause or resume changes
// it. A late disconnect must not relabel an explicit pause as a transport loss.
func (value *Engine) pauseLocked(reason string) {
	if !value.paused || value.pauseReason == "" {
		value.pauseReason = reason
		if value.pauseReason == "" {
			value.pauseReason = pauseReasonUnknown
		}
	}
	value.paused = true
}

func (value *Engine) clearPauseLocked() {
	value.paused = false
	value.pauseReason = ""
}

func (value *Engine) admissionPauseReasonLocked() string {
	if value.takeover || value.acquiring {
		return pauseReasonHumanControl
	}
	if !value.paused {
		return ""
	}
	if value.pauseReason != "" {
		return value.pauseReason
	}
	return pauseReasonUnknown
}

func knownPauseReason(reason string) string {
	switch reason {
	case pauseReasonUser, pauseReasonHumanControl, pauseReasonVoiceCall,
		pauseReasonDisconnected, pauseReasonUnknown, pauseReasonContinuation,
		pauseReasonStopUnknown, pauseReasonRequestFailed, "executor-terminated",
		"continuation-save-failed":
		return reason
	default:
		return ""
	}
}

func unconfirmedPauseReason(state contracts.State) string {
	if _, present := state.Extra[executorStopFenceKey]; present {
		return pauseReasonStopUnknown
	}
	if unconfirmedVoiceTasks(state) {
		return pauseReasonUnknown
	}
	for index := range state.WorkTasks {
		record := &state.WorkTasks[index]
		if !record.UnknownOutcome && record.Status != contracts.WorkStatusUnknown && !workstate.Unconfirmed(record) {
			continue
		}
		if reason := knownPauseReason(record.PauseReason.Value); reason != "" {
			return reason
		}
		for _, message := range state.Messages {
			if !message.UnknownOutcome && message.Submission.Value != contracts.SubmissionStatusUnknown && message.Submission.Value != contracts.SubmissionStatusSubmitting {
				continue
			}
			ownsMessage := message.ID == record.MessageID.Value || slices.Contains(record.MessageIDs, message.ID)
			ownsTurn := message.TurnID.Value != "" && (message.TurnID.Value == record.TurnID || slices.Contains(record.TurnIDs, message.TurnID.Value))
			if !ownsMessage && !ownsTurn {
				continue
			}
			if reason := knownPauseReason(message.PauseReason.Value); reason != "" {
				return reason
			}
		}
		if workstate.Unconfirmed(record) {
			return pauseReasonContinuation
		}
		return pauseReasonUnknown
	}
	return ""
}
