package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	InitialDelayMs     = 5_000
	BaseDelayMs        = 30_000
	MaxDelayMs         = 300_000
	MaxBackoffExponent = 4
	NoProgressLimit    = 3
	MaxSafeInteger     = 9_007_199_254_740_991
)

func ValidTime(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value && value > 0 && value <= MaxTimestamp
}

func ValidID(value string, max int) bool {
	if value == "" || !utf8.ValidString(value) || contracts.UTF16Length(value) > max {
		return false
	}
	for _, r := range value {
		if r <= 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func Delay(count int) float64 {
	exponent := min(max(0, count-1), MaxBackoffExponent)
	return math.Min(MaxDelayMs, BaseDelayMs*math.Pow(2, float64(exponent)))
}

// canonicalString emits ECMAScript JSON.stringify string escaping, including
// unchanged lone UTF-16 surrogates in historical public plan steps.
func canonicalString(value string, legacy contracts.LegacyJSON, key string) string {
	units := utf16.Encode([]rune(value))
	if original, ok := legacy.Original[key]; ok && legacy.Decoded[key] == value {
		if parsed, ok := jsonStringUnits(original); ok {
			units = parsed
		}
	}
	return canonicalUnits(units)
}

func canonicalUnits(units []uint16) string {
	return string(contracts.EncodeJSONTextUnits(units))
}

func jsonStringUnits(raw json.RawMessage) ([]uint16, bool) {
	units, err := contracts.DecodeJSONTextUnits(raw)
	return units, err == nil
}

func Checkpoint(plan *contracts.TaskPlan) string {
	var input strings.Builder
	if plan == nil {
		input.WriteString("null")
	} else {
		input.WriteByte('[')
		for index, step := range plan.Steps {
			if index > 0 {
				input.WriteByte(',')
			}
			input.WriteString(`{"step":`)
			input.WriteString(canonicalString(step.Step, step.LegacyText, "step"))
			input.WriteString(`,"status":`)
			input.WriteString(strconv.Quote(string(step.Status)))
			input.WriteByte('}')
		}
		input.WriteByte(']')
	}
	sum := sha256.Sum256([]byte(input.String()))
	return hex.EncodeToString(sum[:])
}

func SafeContinuation(value *contracts.WorkContinuation) bool {
	if value == nil || len(value.Extra) > 0 || !value.NextAt.Present || (!value.NextAt.Null && !ValidTime(value.NextAt.Value)) || value.Attempts < 0 || value.Attempts > MaxSafeInteger || value.NoProgressCount < 0 || value.NoProgressCount > value.Attempts || len(value.LastCheckpoint) != 64 {
		return false
	}
	for _, character := range value.LastCheckpoint {
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	if value.Invalid {
		return value.Dispatch == nil && value.NextAt.Null
	}
	d := value.Dispatch
	if d == nil {
		return true
	}
	if len(d.Extra) > 0 || !ValidID(d.ID, IDLength) || !ValidID(d.FromTurnID, ReferenceIDLength) || !ValidID(d.ThreadID, ReferenceIDLength) || contracts.TrimText(d.RuntimeID) == "" || contracts.UTF16Length(d.RuntimeID) > RuntimeIDLength || !ValidTime(d.CreatedAt) || !d.Phase.Valid() {
		return false
	}
	for _, character := range d.RuntimeID {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	if d.Phase == contracts.ContinuationDispatchPhaseAcknowledged && !ValidID(d.TurnID, ReferenceIDLength) {
		return false
	}
	if d.TurnID != "" && (!ValidID(d.TurnID, ReferenceIDLength) || d.TurnID == d.FromTurnID) {
		return false
	}
	return !((d.Phase == contracts.ContinuationDispatchPhaseClaimed || d.Phase == contracts.ContinuationDispatchPhaseSubmitting) && d.TurnID != "")
}

func Unconfirmed(record *contracts.WorkRecord) bool {
	return record != nil && record.Continuation != nil && (!SafeContinuation(record.Continuation) || record.Continuation.Invalid || (record.Continuation.Dispatch != nil && (record.Continuation.Dispatch.Phase == contracts.ContinuationDispatchPhaseSubmitting || record.Continuation.Dispatch.Phase == contracts.ContinuationDispatchPhaseUnknown)))
}

// ResumeEligible proves the selected paused work and its known execution boundary.
// Strictly older, detached uncertainty retains its unknown outcome and is never replayed.
func ResumeEligible(record *contracts.WorkRecord, messages []*contracts.ChatMessage, at float64) bool {
	if record == nil || record.Status != contracts.WorkStatusPaused || Unconfirmed(record) || record.Continuation != nil && record.Continuation.Dispatch != nil {
		return false
	}
	return resumeEvidence(record, messages, at)
}

// ResumeClaimEligible revalidates the same locally owned, unacknowledged claim.
// It cannot admit a second claim or authorize an unknown/acknowledged dispatch.
func ResumeClaimEligible(record *contracts.WorkRecord, messages []*contracts.ChatMessage, at float64, attemptID string) bool {
	if record == nil || record.Status != contracts.WorkStatusContinuing || !SafeContinuation(record.Continuation) || record.Continuation.Invalid || record.Continuation.Dispatch == nil {
		return false
	}
	dispatch := record.Continuation.Dispatch
	if dispatch.ID != attemptID || dispatch.FromTurnID != record.TurnID || dispatch.TurnID != "" || dispatch.Phase != contracts.ContinuationDispatchPhaseClaimed && dispatch.Phase != contracts.ContinuationDispatchPhaseSubmitting {
		return false
	}
	return resumeEvidence(record, messages, at)
}

func resumeEvidence(record *contracts.WorkRecord, messages []*contracts.ChatMessage, at float64) bool {
	if !ValidTime(at) {
		return false
	}
	ended := record.ExecutionEndedAt
	if !ValidTime(record.StartedAt) || !ended.Present || ended.Null || !ValidTime(ended.Value) || record.StartedAt > ended.Value || ended.Value > at {
		return false
	}
	if record.UnknownOutcome || record.Submission.Value == contracts.SubmissionStatusUnknown || record.Submission.Value == contracts.SubmissionStatusSubmitting || record.Submission.Value == contracts.SubmissionStatusPreparing {
		return false
	}
	if !Unfinished(record) {
		return false
	}
	lineage, valid := resumeLineage(record, messages)
	if !valid {
		return false
	}
	for _, message := range messages {
		if message == nil {
			return false
		}
		uncertain := message.UnknownOutcome || message.Status.Value == contracts.MessageStatus(contracts.TaskStatusUnknown) || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting || message.Submission.Value == contracts.SubmissionStatusPreparing
		if !uncertain {
			continue
		}
		if resumeOwnsMessage(record, message) || slices.Contains(lineage, message.TurnID.Value) || message.Role == contracts.RoleUser && !historicalDetachedInput(message, record.StartedAt) {
			return false
		}
	}
	return true
}

func resumeOwnsMessage(record *contracts.WorkRecord, message *contracts.ChatMessage) bool {
	if message.ID == record.MessageID.Value || message.ID == record.TaskID.Value || slices.Contains(record.MessageIDs, message.ID) || message.WorkID == record.ID {
		return true
	}
	if message.TurnID.Value != "" && (message.TurnID.Value == record.TurnID || slices.Contains(record.TurnIDs, message.TurnID.Value)) {
		return true
	}
	return message.WorkReply != nil && message.WorkReply.WorkID == record.ID
}

func resumeLineage(record *contracts.WorkRecord, messages []*contracts.ChatMessage) ([]string, bool) {
	if !ValidID(record.TurnID, ReferenceIDLength) {
		return nil, false
	}
	lineage := []string{record.TurnID}
	for _, id := range record.TurnIDs {
		if !ValidID(id, ReferenceIDLength) {
			return nil, false
		}
		if !slices.Contains(lineage, id) {
			lineage = append(lineage, id)
		}
	}
	for _, message := range messages {
		if message == nil {
			return nil, false
		}
		if !resumeOwnsMessage(record, message) {
			continue
		}
		turns := append([]string{}, message.TurnIDs...)
		if message.TurnID.Present && !message.TurnID.Null {
			turns = append(turns, message.TurnID.Value)
		}
		for _, id := range turns {
			if !ValidID(id, ReferenceIDLength) {
				return nil, false
			}
			if !slices.Contains(lineage, id) {
				lineage = append(lineage, id)
			}
		}
	}
	return lineage, true
}

func historicalDetachedInput(message *contracts.ChatMessage, before float64) bool {
	if message.WorkID != "" || message.WorkReply != nil || message.Continuation != nil || message.ParentTaskID.Value != "" || len(message.Work) != 0 {
		return false
	}
	if len(message.TurnIDs) != 0 || message.VoiceCallID != "" || message.CallID != "" || message.Voice || len(message.VoiceContext) != 0 || len(message.CallContext) != 0 {
		return false
	}
	if message.WorkKind != "" && message.WorkKind != "task" && message.WorkKind != "conversation" || message.Kind != "" || message.Provider != "" {
		return false
	}
	if message.TaskID.Value != "" && message.TaskID.Value != message.ID || message.MessageID.Value != "" || len(message.MessageIDs) != 0 || message.ReplyTo.Value != "" || message.Scheduled || message.ScheduleID != "" {
		return false
	}
	var sourceType string
	if encoded, present := message.Source["type"]; present {
		if json.Unmarshal(encoded, &sourceType) != nil || sourceType == "voice" || sourceType == "voice-call" || sourceType == "schedule" || sourceType == "scheduled" {
			return false
		}
	}
	for _, key := range []string{"workId", "turnId", "threadId", "callId", "voiceCallId", "scheduleId", "messageId", "messageIds", "parentTaskId"} {
		if encoded, present := message.Source[key]; present {
			if key == "messageId" && sourceType == "telegram" && telegramTransportMessageID(encoded) {
				continue
			}
			return false
		}
	}
	if !message.Time.Present || message.Time.Null || !ValidTime(message.Time.Value) || message.Time.Value >= before {
		return false
	}
	if message.AcceptedAt.Present && !message.AcceptedAt.Null || message.CancelledAt.Present && !message.CancelledAt.Null {
		return false
	}
	if message.TurnID.Present && !message.TurnID.Null {
		if !ValidID(message.TurnID.Value, ReferenceIDLength) || !message.ExecutorConfirmedAt.Present || message.ExecutorConfirmedAt.Null || !ValidTime(message.ExecutorConfirmedAt.Value) || message.ExecutorConfirmedAt.Value >= before || message.ExecutorConfirmedAt.Value < message.Time.Value {
			return false
		}
	} else if message.ExecutorConfirmedAt.Present && !message.ExecutorConfirmedAt.Null {
		return false
	}
	for _, timestamp := range []contracts.Optional[float64]{message.ReceivedAt, message.QueuedAt, message.ExecutorConfirmedAt, message.ExecutionEndedAt, message.ScheduledAt} {
		if timestamp.Present && !timestamp.Null && (!ValidTime(timestamp.Value) || timestamp.Value >= before) {
			return false
		}
	}
	_, valid := resumeStoredThread(message)
	return valid
}

const telegramTransportMessageIDMaxDigits = 16

// Telegram Source.messageId is an external decimal string emitted by incoming
// identifier(), rather than a dant message, work or executor-turn identity.
func telegramTransportMessageID(encoded json.RawMessage) bool {
	var id string
	if json.Unmarshal(encoded, &id) != nil || len(id) == 0 || len(id) > telegramTransportMessageIDMaxDigits {
		return false
	}
	value, err := strconv.ParseUint(id, 10, 64)
	return err == nil && value > 0 && value <= MaxSafeInteger && strconv.FormatUint(value, 10) == id
}

func resumeStoredThread(message *contracts.ChatMessage) (string, bool) {
	encoded, present := message.Extra["threadId"]
	if !present {
		return "", true
	}
	var id contracts.Optional[string]
	if !contracts.ValidUnicodeJSON(encoded) || json.Unmarshal(encoded, &id) != nil {
		return "", false
	}
	if id.Null {
		return "", true
	}
	return id.Value, ValidID(id.Value, ReferenceIDLength)
}

// ResumeThreadCompatible applies only after a fresh idle, all-terminal inventory.
// A same-thread historical turn must be present; absent/distinct legacy thread
// ownership stays detached, with its historical outcome still explicitly unknown.
func ResumeThreadCompatible(record *contracts.WorkRecord, messages []*contracts.ChatMessage, at float64, threadID string, terminalTurns []string) bool {
	if record == nil || !ValidID(threadID, ReferenceIDLength) || !resumeEvidence(record, messages, at) {
		return false
	}
	for _, message := range messages {
		uncertain := message.UnknownOutcome || message.Status.Value == contracts.MessageStatus(contracts.TaskStatusUnknown) || message.Submission.Value == contracts.SubmissionStatusUnknown || message.Submission.Value == contracts.SubmissionStatusSubmitting || message.Submission.Value == contracts.SubmissionStatusPreparing
		if message.Role != contracts.RoleUser || !uncertain {
			continue
		}
		storedThread, valid := resumeStoredThread(message)
		if !valid || storedThread == threadID && (message.TurnID.Value == "" || !slices.Contains(terminalTurns, message.TurnID.Value)) {
			return false
		}
	}
	return true
}

// ResumeOtherWorkKnown preserves uncertainty barriers for every other registered
// owner. Known paused legacy records remain untouched by the explicit selection.
func ResumeOtherWorkKnown(selectedID string, records []contracts.WorkRecord) bool {
	for index := range records {
		other := &records[index]
		if other.ID == selectedID {
			continue
		}
		if other.UnknownOutcome || other.Status == contracts.WorkStatusUnknown || Unconfirmed(other) || other.Continuation != nil && other.Continuation.Dispatch != nil || other.Submission.Value == contracts.SubmissionStatusUnknown || other.Submission.Value == contracts.SubmissionStatusSubmitting || other.Submission.Value == contracts.SubmissionStatusPreparing {
			return false
		}
	}
	return true
}

func Unfinished(record *contracts.WorkRecord) bool {
	if record == nil {
		return false
	}
	if record.Plan == nil {
		return record.Provisional
	}
	if len(record.Plan.Steps) < 1 || len(record.Plan.Steps) > PlanSteps {
		return false
	}
	unfinished := false
	for _, step := range record.Plan.Steps {
		if !step.Status.Valid() || contracts.TrimText(step.Step) == "" || contracts.UTF16Length(step.Step) > PublicStepLength {
			return false
		}
		unfinished = unfinished || step.Status != contracts.PlanStepStatusCompleted
	}
	return unfinished
}

func Eligible(record *contracts.WorkRecord, at float64) bool {
	if record == nil || !ValidTime(at) || !ValidID(record.ID, IDLength) || !ValidID(record.TurnID, ReferenceIDLength) || record.Status != contracts.WorkStatusContinuing || !ValidTime(record.ExecutionEndedAt.Value) || record.ExecutionEndedAt.Value > at || record.ProgressDismissedAt.Value != 0 || record.UnknownOutcome || record.Submission.Value == contracts.SubmissionStatusUnknown || record.Submission.Value == contracts.SubmissionStatusSubmitting || !Unfinished(record) {
		return false
	}
	if record.Continuation == nil {
		return at >= record.ExecutionEndedAt.Value+InitialDelayMs
	}
	c := record.Continuation
	return SafeContinuation(c) && !c.Invalid && c.Dispatch == nil && c.NoProgressCount < NoProgressLimit && !c.NextAt.Null && at >= c.NextAt.Value
}

func ReplyEligible(record *contracts.WorkRecord, at float64) bool {
	if record == nil || Unconfirmed(record) || record.Continuation != nil && record.Continuation.Dispatch != nil {
		return false
	}
	switch record.Status {
	case contracts.WorkStatusContinuing, contracts.WorkStatusWaitingUser, contracts.WorkStatusPaused, contracts.WorkStatusFailed, contracts.WorkStatusReview, contracts.WorkStatusCompleted, contracts.WorkStatusCancelled:
	default:
		return false
	}
	copy := *record
	if record.Plan != nil {
		plan := *record.Plan
		plan.Steps = append([]contracts.PlanStep(nil), record.Plan.Steps...)
		all := true
		for _, step := range plan.Steps {
			all = all && step.Status == contracts.PlanStepStatusCompleted
		}
		if all && len(plan.Steps) > 0 {
			plan.Steps[0].Status = contracts.PlanStepStatusPending
		}
		copy.Plan = &plan
	}
	copy.Status = contracts.WorkStatusContinuing
	copy.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(at), LastCheckpoint: Checkpoint(record.Plan)}
	return Eligible(&copy, at)
}
