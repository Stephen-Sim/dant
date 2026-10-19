package store

import (
	"bytes"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// ValidateRestoredState validates private backup staging without allocating a
// new conversation or interpreting a restored task as accepted execution.
func ValidateRestoredState(raw []byte) (contracts.State, error) {
	object, err := contracts.DecodeObject(raw, MaxStateBytes)
	if err != nil {
		return contracts.State{}, ErrInvalidState
	}
	id, ok := rawString(object["conversationId"])
	if !ok || !uuidPattern.MatchString(id) {
		return contracts.State{}, ErrInvalidState
	}
	for _, key := range []string{"messages", "workTasks", "completions"} {
		if field, exists := object[key]; !exists || len(bytes.TrimSpace(field)) == 0 || bytes.TrimSpace(field)[0] != '[' {
			return contracts.State{}, ErrInvalidState
		}
	}
	if _, err := contracts.DecodeObject(object["settings"], MaxStateBytes); err != nil {
		return contracts.State{}, ErrInvalidState
	}
	var messages []json.RawMessage
	if json.Unmarshal(object["messages"], &messages) != nil {
		return contracts.State{}, ErrInvalidState
	}
	for _, raw := range messages {
		message, err := contracts.DecodeObject(raw, MaxStateBytes)
		if err != nil {
			return contracts.State{}, ErrInvalidState
		}
		_, idOK := rawString(message["id"])
		role, roleOK := rawString(message["role"])
		if !idOK || !roleOK || !contracts.Role(role).Valid() {
			return contracts.State{}, ErrInvalidState
		}
	}
	return restore(raw, func() string {
		return ""
	}, false)
}

// PauseRestoredState keeps raw legacy content and timestamps byte-for-byte at
// each JSON value while removing execution bindings. It does not open a Store.
func PauseRestoredState(raw []byte) ([]byte, error) {
	if _, err := ValidateRestoredState(raw); err != nil {
		return nil, err
	}
	object, _ := contracts.DecodeObject(raw, MaxStateBytes)
	object["threadId"] = json.RawMessage("null")
	object["threadRuntime"] = json.RawMessage("null")
	delete(object, "threadConversationId")
	for _, key := range []string{"messages", "workTasks"} {
		var entries []json.RawMessage
		if json.Unmarshal(object[key], &entries) != nil {
			return nil, ErrInvalidState
		}
		for index, raw := range entries {
			entry, err := contracts.DecodeObject(raw, MaxStateBytes)
			if err != nil {
				return nil, ErrInvalidState
			}
			if key == "messages" {
				role, _ := rawString(entry["role"])
				if role != string(contracts.RoleUser) {
					if status, _ := rawString(entry["status"]); status == string(contracts.MessageStatusStreaming) {
						entry["status"] = json.RawMessage(`"paused"`)
					}
					entries[index], err = json.Marshal(entry)
					if err != nil {
						return nil, ErrInvalidState
					}
					continue
				}
			}
			if err := pauseRestoredRecord(entry); err != nil {
				return nil, err
			}
			entries[index], err = json.Marshal(entry)
			if err != nil {
				return nil, ErrInvalidState
			}
		}
		object[key], _ = json.Marshal(entries)
	}
	if raw, exists := object["callInputHistory"]; exists {
		var entries []json.RawMessage
		if json.Unmarshal(raw, &entries) == nil {
			for index, raw := range entries {
				entry, err := contracts.DecodeObject(raw, MaxStateBytes)
				if err != nil {
					continue
				}
				if submission, _ := rawString(entry["submission"]); submission == "pending" {
					entry["submission"] = json.RawMessage(`"unknown"`)
					entries[index], _ = json.Marshal(entry)
				}
			}
			object["callInputHistory"], _ = json.Marshal(entries)
		}
	}
	return json.Marshal(object)
}

func pauseRestoredRecord(entry contracts.RawObject) error {
	status, _ := rawString(entry["status"])
	submission, _ := rawString(entry["submission"])
	unknown := bytes.Equal(bytes.TrimSpace(entry["unknownOutcome"]), []byte("true"))
	if status == string(contracts.TaskStatusUnknown) || unknown || submission == string(contracts.SubmissionStatusUnknown) || submission == string(contracts.SubmissionStatusSubmitting) {
		entry["status"] = json.RawMessage(`"unknown"`)
		entry["unknownOutcome"] = json.RawMessage("true")
		if submission == string(contracts.SubmissionStatusSubmitting) {
			entry["submission"] = json.RawMessage(`"unknown"`)
		}
	} else {
		switch contracts.TaskStatus(status) {
		case contracts.TaskStatusCompleted, contracts.TaskStatusCancelled, contracts.TaskStatusFailed, contracts.TaskStatusReview:
		default:
			entry["status"] = json.RawMessage(`"paused"`)
		}
	}
	if raw, exists := entry["continuation"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		continuation, err := contracts.DecodeObject(raw, MaxStateBytes)
		if err != nil {
			return ErrInvalidState
		}
		continuation["nextAt"] = json.RawMessage("null")
		if raw, exists := continuation["dispatch"]; exists {
			dispatch, err := contracts.DecodeObject(raw, MaxStateBytes)
			if err != nil {
				return ErrInvalidState
			}
			phase, _ := rawString(dispatch["phase"])
			if phase != string(contracts.ContinuationDispatchPhaseAcknowledged) {
				dispatch["phase"] = json.RawMessage(`"unknown"`)
				entry["status"] = json.RawMessage(`"unknown"`)
				entry["unknownOutcome"] = json.RawMessage("true")
			}
			continuation["dispatch"], _ = json.Marshal(dispatch)
		}
		entry["continuation"], _ = json.Marshal(continuation)
	}
	return nil
}
