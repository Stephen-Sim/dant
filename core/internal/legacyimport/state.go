package legacyimport

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func copyObject(value contracts.RawObject) contracts.RawObject {
	result := make(contracts.RawObject, len(value))
	for key, raw := range value {
		result[key] = append(json.RawMessage{}, raw...)
	}
	return result
}

func wire(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func pauseRecord(value contracts.RawObject, work bool) error {
	rawStatus, statusPresent := value["status"]
	status, statusText := text(rawStatus)
	submission, hasSubmission := text(value["submission"])
	unknown := bytes.Equal(value["unknownOutcome"], []byte("true")) ||
		status == string(contracts.TaskStatusUnknown) ||
		submission == string(contracts.SubmissionStatusUnknown) ||
		submission == string(contracts.SubmissionStatusSubmitting)
	if raw, present := value["submission"]; present && !bytes.Equal(raw, []byte("null")) &&
		(!hasSubmission || !contracts.SubmissionStatus(submission).Valid()) {
		unknown = true
	}
	unknownStatus := statusPresent && (!statusText || (!contracts.TaskStatus(status).Valid() &&
		status != string(contracts.MessageStatusRead) && status != string(contracts.MessageStatusStreaming)))
	if unknownStatus {
		// Preserve an unfamiliar wire value as evidence. The owning Store also
		// recognizes unknownOutcome and cannot interpret it as admission.
		value["unknownOutcome"] = wire(true)
	} else if unknown {
		value["status"] = wire(contracts.TaskStatusUnknown)
		value["unknownOutcome"] = wire(true)
	} else if work || statusText {
		switch contracts.TaskStatus(status) {
		case contracts.TaskStatusCompleted, contracts.TaskStatusCancelled, contracts.TaskStatusFailed, contracts.TaskStatusReview:
		default:
			value["status"] = wire(contracts.TaskStatusPaused)
		}
	}
	if submission == string(contracts.SubmissionStatusSubmitting) ||
		submission == string(contracts.SubmissionStatusPreparing) {
		value["submission"] = wire(contracts.SubmissionStatusUnknown)
		value["unknownOutcome"] = wire(true)
		if !unknownStatus {
			value["status"] = wire(contracts.TaskStatusUnknown)
		}
	}
	if raw, exists := value["continuation"]; exists && !bytes.Equal(raw, []byte("null")) {
		continuation, err := contracts.DecodeObject(raw, stateMaxBytes)
		if err != nil {
			return ErrInvalid
		}
		continuation["nextAt"] = wire(nil)
		if dispatchRaw, exists := continuation["dispatch"]; exists && !bytes.Equal(dispatchRaw, []byte("null")) {
			dispatch, err := contracts.DecodeObject(dispatchRaw, stateMaxBytes)
			if err != nil {
				return ErrInvalid
			}
			phase, _ := text(dispatch["phase"])
			if phase != string(contracts.ContinuationDispatchPhaseAcknowledged) {
				dispatch["phase"] = wire(contracts.ContinuationDispatchPhaseUnknown)
				if !unknownStatus {
					value["status"] = wire(contracts.TaskStatusUnknown)
				}
				value["unknownOutcome"] = wire(true)
			}
			continuation["dispatch"] = wire(dispatch)
		}
		value["continuation"] = wire(continuation)
	}
	return nil
}

func (value *source) transform(mapped map[string]contracts.Attachment, warnings []string) ([]byte, error) {
	state := copyObject(value.state)
	messages, err := objects(state["messages"], true)
	if err != nil {
		return nil, err
	}
	for _, message := range messages {
		attachments, err := objects(message["attachments"], true)
		if err != nil {
			return nil, err
		}
		for index, original := range attachments {
			id, _ := text(original["id"])
			if item, exists := mapped[id]; exists {
				encoded := wire(item)
				attachments[index], err = contracts.DecodeObject(encoded, filesMetadataLimit)
				if err != nil {
					return nil, ErrInvalid
				}
			} else if mapped != nil {
				original["unavailable"] = wire(true)
			}
		}
		if _, exists := message["attachments"]; exists {
			message["attachments"] = wire(attachments)
		}
		role, _ := text(message["role"])
		if role == string(contracts.RoleUser) {
			if err := pauseRecord(message, false); err != nil {
				return nil, err
			}
		} else if status, _ := text(message["status"]); status == string(contracts.MessageStatusStreaming) {
			message["status"] = wire(contracts.TaskStatusPaused)
		}
	}
	if _, exists := state["messages"]; exists {
		state["messages"] = wire(messages)
	}
	if raw, exists := state["workTasks"]; exists {
		records, err := objects(raw, false)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			if err := pauseRecord(record, true); err != nil {
				return nil, err
			}
		}
		state["workTasks"] = wire(records)
	}
	if raw, exists := state["schedules"]; exists {
		records, err := objects(raw, false)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			record["enabled"] = wire(false)
			status, exists := text(record["status"])
			if !exists || (contracts.ScheduleStatus(status).Valid() && status != string(contracts.ScheduleStatusDispatched)) {
				record["status"] = wire(contracts.ScheduleStatusPaused)
			}
		}
		state["schedules"] = wire(records)
	}
	if raw, exists := state["callInputHistory"]; exists {
		records, err := objects(raw, false)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			if status, _ := text(record["submission"]); status == string(contracts.SpokenReferenceStatusPending) {
				record["submission"] = wire(contracts.SpokenReferenceStatusUnknown)
			}
		}
		state["callInputHistory"] = wire(records)
	}
	for _, name := range []string{"threadId", "threadRuntime", "threadConversationId", "active", "call"} {
		if _, exists := state[name]; exists {
			state[name] = wire(nil)
		}
	}
	if _, exists := state["queue"]; exists {
		state["queue"] = wire([]string{})
	}
	settings := contracts.RawObject{}
	if raw := state["settings"]; raw != nil && !bytes.Equal(raw, []byte("null")) {
		settings, err = contracts.DecodeObject(raw, stateMaxBytes)
		if err != nil {
			return nil, ErrInvalid
		}
	}
	settings["vm"] = wire(struct {
		Host       string `json:"host"`
		User       string `json:"user"`
		Port       int    `json:"port"`
		KeyPath    string `json:"keyPath"`
		KnownHosts string `json:"knownHosts"`
	}{User: "dant", Port: config.DefaultSSHPort})
	state["settings"] = wire(settings)
	migration := copyObject(value.manifest)
	if warnings == nil {
		warnings = []string{}
	}
	migration["warnings"] = wire(warnings)
	migration["importedAt"] = wire(time.Now().UTC().Format(time.RFC3339Nano))
	state["migration"] = wire(migration)
	raw, err := json.Marshal(state)
	if err != nil || len(raw) > stateMaxBytes {
		return nil, ErrCapacity
	}
	return raw, nil
}
