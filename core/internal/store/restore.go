package store

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const MaxTimestamp = 8_640_000_000_000_000

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validTimestamp(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 && value <= MaxTimestamp
}

func rawString(raw json.RawMessage) (string, bool) {
	var result string
	if !contracts.ValidUnicodeJSON(raw) || json.Unmarshal(raw, &result) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	return result, true
}

func stringList(raw json.RawMessage) []string {
	var values []json.RawMessage
	result := make([]string, 0)
	if json.Unmarshal(raw, &values) != nil {
		return result
	}
	for _, raw := range values {
		if value, ok := rawString(raw); ok {
			result = append(result, value)
		}
	}
	return result
}

// Restore tolerates absent/invalid optional legacy fields without interpreting
// them as execution confirmation. Identities are never Unicode-repaired.
func decodeLegacyFields(raw contracts.RawObject, target any) error {
	value := reflect.ValueOf(target).Elem()
	typ := value.Type()
	remaining := make(contracts.RawObject)
	for key, rawValue := range raw {
		remaining[key] = rawValue
	}
	for index := 0; index < typ.NumField(); index++ {
		field := typ.Field(index)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		rawValue, exists := raw[name]
		if !exists {
			continue
		}
		delete(remaining, name)
		fieldValue := value.Field(index)
		// Invalid optional values retain the already initialized safe default.
		decoded := reflect.New(fieldValue.Type())
		if json.Unmarshal(rawValue, decoded.Interface()) == nil {
			fieldValue.Set(decoded.Elem())
		}
	}
	if field := value.FieldByName("Extra"); field.IsValid() {
		field.Set(reflect.ValueOf(remaining))
	}
	return nil
}

func restoreMessage(raw json.RawMessage, restarting bool) (*contracts.ChatMessage, error) {
	fields, err := contracts.DecodeObject(raw, len(raw))
	if err != nil {
		return nil, nil
	}
	id, ok := rawString(fields["id"])
	if !ok {
		return nil, ErrInvalidState
	}
	role, ok := rawString(fields["role"])
	if !ok || !contracts.Role(role).Valid() {
		return nil, nil
	}
	for _, key := range []string{"turnId", "workId", "taskId", "messageId", "parentTaskId", "clientMessageId", "replyTo", "scheduleId", "callId", "voiceCallId"} {
		if value, exists := fields[key]; exists && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) && !contracts.ValidUnicodeJSON(value) {
			return nil, ErrInvalidState
		}
	}
	value := &contracts.ChatMessage{ID: id, Role: contracts.Role(role), Reactions: []string{}}
	if err = decodeLegacyFields(fields, value); err != nil {
		return nil, err
	}
	if rawStatus, exists := fields["status"]; exists {
		var status contracts.MessageStatus
		if json.Unmarshal(rawStatus, &status) != nil {
			value.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusUnknown))
			value.UnknownOutcome = true
		}
	}
	if rawSubmission, exists := fields["submission"]; exists && !bytes.Equal(bytes.TrimSpace(rawSubmission), []byte("null")) {
		var status contracts.SubmissionStatus
		if json.Unmarshal(rawSubmission, &status) != nil {
			value.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			value.UnknownOutcome = true
		}
	}
	if rawPriority, exists := fields["progressPriority"]; exists {
		var priority contracts.TaskPriority
		if json.Unmarshal(rawPriority, &priority) != nil {
			value.ProgressPriority = contracts.Some(contracts.TaskPriorityNormal)
		}
	}
	value.Reactions = stringList(fields["reactions"])
	// Run checked DTO decoding again after normalization to capture preserved
	// raw escaped text and nested future fields without retaining invalid enums.
	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, ErrInvalidState
	}
	var normalizedFields contracts.RawObject
	if json.Unmarshal(normalized, &normalizedFields) != nil {
		return nil, ErrInvalidState
	}
	if text, exists := fields["text"]; exists {
		var display string
		if json.Unmarshal(text, &display) == nil && !bytes.Equal(bytes.TrimSpace(text), []byte("null")) {
			normalizedFields["text"] = text
		}
	}
	normalized, err = json.Marshal(normalizedFields)
	if err != nil || json.Unmarshal(normalized, value) != nil {
		return nil, ErrInvalidState
	}
	if restarting {
		status := contracts.TaskStatus(value.Status.Value)
		if value.Role == contracts.RoleUser {
			if value.Status.Value == contracts.MessageStatusRead {
				status = contracts.TaskStatusReview
				value.Status = contracts.Some(contracts.MessageStatus(status))
			}
			if value.Submission.Value == contracts.SubmissionStatusSubmitting {
				value.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
				value.UnknownOutcome = true
				if status != contracts.TaskStatusReview && status != contracts.TaskStatusCompleted {
					status = contracts.TaskStatusUnknown
					value.PauseReason = contracts.Some("restart")
				}
			}
			if (value.UnknownOutcome || value.Submission.Value == contracts.SubmissionStatusUnknown) && status != contracts.TaskStatusReview && status != contracts.TaskStatusCompleted && status != contracts.TaskStatusCancelled && status != contracts.TaskStatusFailed {
				status = contracts.TaskStatusUnknown
			}
			switch status {
			case contracts.TaskStatusQueued, contracts.TaskStatusRunning, contracts.TaskStatusWaitingUser, contracts.TaskStatusPausing, contracts.TaskStatusInterrupted:
				status = contracts.TaskStatusPaused
				value.PauseReason = contracts.Some("restart")
			}
			if !value.Status.Present {
				status = contracts.TaskStatusDraft
			}
			value.Status = contracts.Some(contracts.MessageStatus(status))
			if !value.ExecutorConfirmedAt.Present {
				value.ExecutorConfirmedAt = contracts.Null[float64]()
			}
		} else if value.Status.Value == contracts.MessageStatusStreaming {
			value.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			value.PauseReason = contracts.Some("restart")
		}
	}
	return value, nil
}

func restore(
	raw []byte,
	newID func() string,
	restarting bool) (contracts.State, error) {
	fields, err := contracts.DecodeObject(raw, MaxStateBytes)
	if err != nil {
		return contracts.State{}, ErrInvalidState
	}
	state := contracts.State{Version: 2, Messages: []*contracts.ChatMessage{}, Completions: []contracts.Completion{}, WorkTasks: []contracts.WorkRecord{}, DeletedClientMessageIDs: []string{}, Settings: contracts.Settings{Language: "zh", Voice: "marin", Notifications: true, ShowCallCaptions: true, VM: contracts.VMSettings{User: "dant", Port: 22}}}
	outer := make(contracts.RawObject)
	for key, value := range fields {
		outer[key] = value
	}
	for _, key := range []string{"messages", "workTasks", "completions", "settings"} {
		delete(outer, key)
	}
	if err = decodeLegacyFields(outer, &state); err != nil {
		return state, err
	}
	if rawID, exists := fields["conversationId"]; exists {
		if !contracts.ValidUnicodeJSON(rawID) {
			return state, ErrInvalidState
		}
		id, ok := rawString(rawID)
		if !ok || !uuidPattern.MatchString(id) {
			return state, ErrInvalidState
		}
		state.ConversationID = id
	} else {
		state.ConversationID = newID()
		if !uuidPattern.MatchString(state.ConversationID) {
			return state, ErrInvalidState
		}
	}
	for _, key := range []string{"threadId", "threadRuntime", "threadConversationId"} {
		if raw, exists := fields[key]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) && !contracts.ValidUnicodeJSON(raw) {
			return state, ErrInvalidState
		}
	}
	if settings, exists := fields["settings"]; exists {
		if object, decodeErr := contracts.DecodeObject(settings, len(settings)); decodeErr == nil {
			vm := object["vm"]
			delete(object, "vm")
			_ = decodeLegacyFields(object, &state.Settings)
			if vmObject, decodeErr := contracts.DecodeObject(vm, len(vm)); decodeErr == nil {
				_ = decodeLegacyFields(vmObject, &state.Settings.VM)
			}
		}
	}
	var messages []json.RawMessage
	if json.Unmarshal(fields["messages"], &messages) == nil {
		for _, raw := range messages {
			message, decodeErr := restoreMessage(raw, restarting)
			if decodeErr != nil {
				return state, decodeErr
			}
			if message != nil {
				state.Messages = append(state.Messages, message)
			}
		}
	}
	var completions []json.RawMessage
	if json.Unmarshal(fields["completions"], &completions) == nil {
		for _, raw := range completions {
			var value contracts.Completion
			if json.Unmarshal(raw, &value) == nil && value.ID != "" {
				state.Completions = append(state.Completions, value)
			}
		}
	}
	var tasks []json.RawMessage
	if json.Unmarshal(fields["workTasks"], &tasks) == nil {
		for _, raw := range tasks {
			value, restoreErr := restoreWorkRecord(raw, restarting)
			if restoreErr != nil {
				return state, restoreErr
			}
			if value == nil {
				continue
			}
			state.WorkTasks = append(state.WorkTasks, *value)
		}
	}
	if len(state.WorkTasks) > 300 {
		state.WorkTasks = state.WorkTasks[len(state.WorkTasks)-300:]
	}
	state.Version = 2
	return state, nil
}

func restoreWorkRecord(raw json.RawMessage, restarting bool) (*contracts.WorkRecord, error) {
	fields, err := contracts.DecodeObject(raw, MaxStateBytes)
	if err != nil {
		return nil, nil
	}
	id, idOK := rawString(fields["id"])
	turnID, turnOK := rawString(fields["turnId"])
	source, sourceOK := rawString(fields["source"])
	if !idOK || !turnOK {
		return nil, ErrInvalidState
	}
	if raw, exists := fields["turnIds"]; exists && !contracts.ValidUnicodeJSON(raw) {
		return nil, ErrInvalidState
	}
	if !uuidPattern.MatchString(id) || turnID == "" || contracts.UTF16Length(turnID) > workstate.ReferenceIDLength || !sourceOK || source != "chat" && source != "voice" {
		return nil, nil
	}
	for _, key := range []string{"messageId", "taskId"} {
		if raw, exists := fields[key]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) && !contracts.ValidUnicodeJSON(raw) {
			return nil, ErrInvalidState
		}
	}

	withoutPlan := bytes.Equal(bytes.TrimSpace(fields["provisional"]), []byte("true")) && bytes.Equal(bytes.TrimSpace(fields["plan"]), []byte("null"))
	steps := json.RawMessage(`[{"step":"Title validation only","status":"pending"}]`)
	if !withoutPlan {
		planFields, err := contracts.DecodeObject(fields["plan"], MaxStateBytes)
		if err != nil {
			return nil, nil
		}
		steps = planFields["steps"]
	}
	safe, err := workstate.ReadPlanInput(contracts.RawObject{"title": fields["title"], "steps": steps}, nil)
	if err != nil {
		return nil, nil
	}
	value := contracts.WorkRecord{ID: id, TurnID: turnID, Source: source, Status: contracts.WorkStatusUnknown, MessageID: contracts.Null[string](), Title: safe.Title, LegacyText: safe.LegacyTitle}
	remaining := make(contracts.RawObject, len(fields))
	for key, raw := range fields {
		remaining[key] = raw
	}
	delete(remaining, "continuation")
	delete(remaining, "plan")
	delete(remaining, "title")
	_ = decodeLegacyFields(remaining, &value)
	value.Title = safe.Title
	value.LegacyText = safe.LegacyTitle
	if !withoutPlan {
		value.Plan = &safe.Plan
		var original contracts.TaskPlan
		if json.Unmarshal(fields["plan"], &original) == nil {
			value.Plan.Extra = original.Extra
			for index := range value.Plan.Steps {
				if index < len(original.Steps) {
					value.Plan.Steps[index].Extra = original.Steps[index].Extra
				}
			}
		}
	}
	value.TurnIDs = uniqueStrings(stringList(fields["turnIds"]), []string{turnID})
	if raw, exists := fields["submission"]; exists {
		var submission contracts.SubmissionStatus
		if json.Unmarshal(raw, &submission) != nil {
			value.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			value.UnknownOutcome = true
		}
	}
	if raw, exists := fields["progressPriority"]; exists {
		var priority contracts.TaskPriority
		if json.Unmarshal(raw, &priority) != nil {
			value.ProgressPriority = contracts.Some(contracts.TaskPriorityNormal)
		}
	}

	if raw, exists := fields["continuation"]; exists {
		var continuation contracts.WorkContinuation
		valid := json.Unmarshal(raw, &continuation) == nil && workstate.SafeContinuation(&continuation)
		if valid && continuation.Dispatch != nil {
			dispatch := continuation.Dispatch
			owner := dispatch.FromTurnID
			if dispatch.TurnID != "" {
				owner = dispatch.TurnID
			}
			valid = value.TurnID == owner && slices.Contains(value.TurnIDs, dispatch.FromTurnID)
		}
		if !valid {
			value.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: workstate.Checkpoint(value.Plan), Invalid: true}
			value.Status = contracts.WorkStatusUnknown
			value.PauseReason = contracts.Some("continuation-state-invalid")
		} else {
			value.Continuation = &continuation
			if continuation.Invalid {
				value.Status = contracts.WorkStatusUnknown
				value.PauseReason = contracts.Some("continuation-state-invalid")
			}
			if restarting && continuation.Dispatch != nil {
				value.Status = contracts.WorkStatusPaused
				value.PauseReason = contracts.Some("continuation-interrupted")
				if continuation.Dispatch.Phase == contracts.ContinuationDispatchPhaseSubmitting || continuation.Dispatch.Phase == contracts.ContinuationDispatchPhaseUnknown {
					value.Status = contracts.WorkStatusUnknown
					value.PauseReason = contracts.Some("continuation-unconfirmed")
				}
			}
			if value.Status == contracts.WorkStatusContinuing && continuation.NoProgressCount >= workstate.NoProgressLimit {
				value.Status = contracts.WorkStatusPaused
				value.PauseReason = contracts.Some("automatic-no-progress")
				continuation.NextAt = contracts.Null[float64]()
			}
		}
	}

	if restarting {
		if value.Status == contracts.WorkStatusReview && workstate.Unfinished(&value) {
			value.Status = contracts.WorkStatusContinuing
		}
		if value.Status == contracts.WorkStatusRunning || value.Status == contracts.WorkStatusPausing || value.Status == contracts.WorkStatusWaitingUser && !value.ExecutionEndedAt.Present {
			value.Status = contracts.WorkStatusPaused
			value.PauseReason = contracts.Some("restart")
		}
		if value.UnknownOutcome || value.Submission.Value == contracts.SubmissionStatusUnknown || value.Submission.Value == contracts.SubmissionStatusSubmitting {
			value.Status = contracts.WorkStatusUnknown
			value.UnknownOutcome = true
			if value.Submission.Value == contracts.SubmissionStatusSubmitting {
				value.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			}
		}
	}
	return &value, nil
}
