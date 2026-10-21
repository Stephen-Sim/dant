package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
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
