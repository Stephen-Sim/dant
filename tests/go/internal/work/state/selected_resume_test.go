package state

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func selectedResumeRecord() *contracts.WorkRecord {
	plan := &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Synthetic remaining work", Status: contracts.PlanStepStatusPending}}, Total: 1}
	return &contracts.WorkRecord{
		ID: "selected-work", TurnID: "selected-turn", TurnIDs: []string{"previous-turn", "selected-turn"},
		MessageID: contracts.Some("selected-input"), MessageIDs: []string{"selected-input", "selected-followup"},
		Status: contracts.WorkStatusPaused, Submission: contracts.Some(contracts.SubmissionStatusConfirmed),
		StartedAt: 2000, ExecutionEndedAt: contracts.Some(float64(3000)), Plan: plan,
	}
}

func historicalResumeUnknown() *contracts.ChatMessage {
	return &contracts.ChatMessage{
		ID: "historical-orphan", Role: contracts.RoleUser, Text: "Synthetic historical uncertainty",
		Time: contracts.Some(float64(1000)), ReceivedAt: contracts.Some(float64(1100)),
		TaskID:     contracts.Some("historical-orphan"),
		Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusUnknown)),
		Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
	}
}

func TestSelectedResumeEligibilityRetainsHistoricalUnknownAndSelectedTaskBytes(t *testing.T) {
	record, orphan := selectedResumeRecord(), historicalResumeUnknown()
	selected := &contracts.ChatMessage{ID: "selected-input", Role: contracts.RoleUser, Time: contracts.Some(float64(2000)), WorkID: record.ID, Submission: contracts.Some(contracts.SubmissionStatusConfirmed)}
	messages := []*contracts.ChatMessage{orphan, selected}
	before, err := json.Marshal([]any{record, messages})
	if err != nil {
		t.Fatal(err)
	}
	if !ResumeEligible(record, messages, 4000) {
		t.Fatal("an unrelated, strictly older orphan prevented an explicit known selection")
	}
	after, err := json.Marshal([]any{record, messages})
	if err != nil || string(before) != string(after) || !orphan.UnknownOutcome || orphan.Submission.Value != contracts.SubmissionStatusUnknown {
		t.Fatal("eligibility rewrote a task or reconciled historical uncertainty", err)
	}
	orphan.ReceivedAt = contracts.Optional[float64]{}
	orphan.ExecutionEndedAt = contracts.Null[float64]()
	if !ResumeEligible(record, []*contracts.ChatMessage{orphan}, 4000) {
		t.Fatal("legacy omitted receipt/null execution end lost its valid stored creation-time fence")
	}
}

func TestSelectedResumeRejectsUnknownWithoutStrictStoredAgeAndOwnershipProof(t *testing.T) {
	cases := map[string]func(*contracts.ChatMessage){
		"same creation":           func(m *contracts.ChatMessage) { m.Time = contracts.Some(float64(2000)) },
		"new creation":            func(m *contracts.ChatMessage) { m.Time = contracts.Some(float64(2001)) },
		"missing creation":        func(m *contracts.ChatMessage) { m.Time = contracts.Optional[float64]{} },
		"null creation":           func(m *contracts.ChatMessage) { m.Time = contracts.Null[float64]() },
		"invalid creation":        func(m *contracts.ChatMessage) { m.Time = contracts.Some(math.NaN()) },
		"fractional creation":     func(m *contracts.ChatMessage) { m.Time = contracts.Some(1000.5) },
		"same receipt":            func(m *contracts.ChatMessage) { m.ReceivedAt = contracts.Some(float64(2000)) },
		"new queue":               func(m *contracts.ChatMessage) { m.QueuedAt = contracts.Some(float64(2001)) },
		"same execution end":      func(m *contracts.ChatMessage) { m.ExecutionEndedAt = contracts.Some(float64(2000)) },
		"invalid queue":           func(m *contracts.ChatMessage) { m.QueuedAt = contracts.Some(math.Inf(1)) },
		"invalid execution end":   func(m *contracts.ChatMessage) { m.ExecutionEndedAt = contracts.Some(float64(-1)) },
		"same schedule timestamp": func(m *contracts.ChatMessage) { m.ScheduledAt = contracts.Some(float64(2000)) },
		"scheduled":               func(m *contracts.ChatMessage) { m.Scheduled = true },
		"schedule owner":          func(m *contracts.ChatMessage) { m.ScheduleID = "known-schedule" },
		"executor proof":          func(m *contracts.ChatMessage) { m.ExecutorConfirmedAt = contracts.Some(float64(1200)) },
		"accepted proof":          func(m *contracts.ChatMessage) { m.AcceptedAt = contracts.Some(float64(1200)) },
		"cancelled proof":         func(m *contracts.ChatMessage) { m.CancelledAt = contracts.Some(float64(1200)) },
		"selected input":          func(m *contracts.ChatMessage) { m.ID = "selected-input" },
		"selected followup":       func(m *contracts.ChatMessage) { m.ID = "selected-followup" },
		"selected work":           func(m *contracts.ChatMessage) { m.WorkID = "selected-work" },
		"selected turn":           func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("selected-turn") },
		"previous selected turn":  func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("previous-turn") },
		"selected reply":          func(m *contracts.ChatMessage) { m.WorkReply = &contracts.WorkReplyTarget{WorkID: "selected-work"} },
		"other registered work":   func(m *contracts.ChatMessage) { m.WorkID = "other-work" },
		"other turn":              func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("other-turn") },
		"turn history":            func(m *contracts.ChatMessage) { m.TurnIDs = []string{"other-turn"} },
		"reply identity":          func(m *contracts.ChatMessage) { m.WorkReply = &contracts.WorkReplyTarget{WorkID: "other-work"} },
		"voice owner":             func(m *contracts.ChatMessage) { m.VoiceCallID = "voice-call" },
		"call owner":              func(m *contracts.ChatMessage) { m.CallID = "call" },
		"different task":          func(m *contracts.ChatMessage) { m.TaskID = contracts.Some("different-task") },
		"message owner":           func(m *contracts.ChatMessage) { m.MessageID = contracts.Some("related-message") },
		"message history":         func(m *contracts.ChatMessage) { m.MessageIDs = []string{"related-message"} },
		"parent task":             func(m *contracts.ChatMessage) { m.ParentTaskID = contracts.Some("retained-parent-task") },
		"legacy continuation": func(m *contracts.ChatMessage) {
			m.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: Checkpoint(nil)}
		},
		"voice input": func(m *contracts.ChatMessage) { m.Voice = true },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			message := historicalResumeUnknown()
			mutate(message)
			if ResumeEligible(selectedResumeRecord(), []*contracts.ChatMessage{message}, 4000) {
				t.Fatal("an unproved age or known action owner became an unrelated historical orphan")
			}
		})
	}
	if ResumeEligible(selectedResumeRecord(), []*contracts.ChatMessage{nil}, 4000) {
		t.Fatal("missing message evidence was ignored")
	}
}

func TestSelectedResumeNeverAdmitsItsOwnUncertainOrDispatchedWork(t *testing.T) {
	cases := map[string]func(*contracts.WorkRecord){
		"active":             func(r *contracts.WorkRecord) { r.Status = contracts.WorkStatusRunning },
		"unknown outcome":    func(r *contracts.WorkRecord) { r.UnknownOutcome = true },
		"submitting":         func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusSubmitting) },
		"preparing":          func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusPreparing) },
		"unknown submission": func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusUnknown) },
		"missing start":      func(r *contracts.WorkRecord) { r.StartedAt = 0 },
		"missing stop":       func(r *contracts.WorkRecord) { r.ExecutionEndedAt = contracts.Optional[float64]{} },
		"null stop":          func(r *contracts.WorkRecord) { r.ExecutionEndedAt = contracts.Null[float64]() },
		"stop before start":  func(r *contracts.WorkRecord) { r.ExecutionEndedAt = contracts.Some(float64(1000)) },
		"future stop":        func(r *contracts.WorkRecord) { r.ExecutionEndedAt = contracts.Some(float64(5000)) },
		"completed":          func(r *contracts.WorkRecord) { r.Plan.Steps[0].Status = contracts.PlanStepStatusCompleted },
		"invalid continuation": func(r *contracts.WorkRecord) {
			r.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), Invalid: true, LastCheckpoint: Checkpoint(r.Plan)}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			record := selectedResumeRecord()
			mutate(record)
			if ResumeEligible(record, []*contracts.ChatMessage{historicalResumeUnknown()}, 4000) {
				t.Fatal("selected work's own safety fence was bypassed")
			}
		})
	}
	for _, phase := range []contracts.ContinuationDispatchPhase{contracts.ContinuationDispatchPhaseClaimed, contracts.ContinuationDispatchPhaseSubmitting, contracts.ContinuationDispatchPhaseAcknowledged, contracts.ContinuationDispatchPhaseUnknown} {
		record := selectedResumeRecord()
		dispatch := &contracts.ContinuationDispatch{ID: "existing-attempt", FromTurnID: record.TurnID, RuntimeID: "vm:fixture", ThreadID: "thread", CreatedAt: 3000, Phase: phase}
		if phase == contracts.ContinuationDispatchPhaseAcknowledged {
			dispatch.TurnID = "acknowledged-turn"
		}
		record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: Checkpoint(record.Plan), Dispatch: dispatch}
		if ResumeEligible(record, nil, 4000) {
			t.Fatal("existing dispatch was replayed by a new explicit claim", phase)
		}
	}
	for _, at := range []float64{0, 3000.5, math.NaN(), math.Inf(1)} {
		if ResumeEligible(selectedResumeRecord(), nil, at) {
			t.Fatal("invalid admission time was accepted")
		}
	}
}

func detachedResumeInputs() []*contracts.ChatMessage {
	first := historicalResumeUnknown()
	first.ID, first.TaskID = "detached-first", contracts.Some("detached-first")
	first.TurnID = contracts.Some("detached-turn-one")
	first.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
	first.QueuedAt, first.ExecutorConfirmedAt = contracts.Some(float64(1100)), contracts.Some(float64(1200))
	first.ExecutionEndedAt = contracts.Null[float64]()
	second := historicalResumeUnknown()
	second.ID, second.TaskID = "detached-second", contracts.Some("detached-second")
	second.Time, second.ReceivedAt = contracts.Some(float64(900)), contracts.Null[float64]()
	second.QueuedAt, second.ExecutorConfirmedAt = contracts.Some(float64(1000)), contracts.Some(float64(1100))
	second.ExecutionEndedAt = contracts.Null[float64]()
	second.TurnID = contracts.Some("detached-turn-two")
	return []*contracts.ChatMessage{first, second}
}

func TestSelectedResumeLeavesTwoOlderConfirmedDetachedInputsUnknownAndUnchanged(t *testing.T) {
	record, messages := selectedResumeRecord(), detachedResumeInputs()
	before, err := json.Marshal(messages)
	if err != nil {
		t.Fatal(err)
	}
	if !ResumeEligible(record, messages, 4000) || !ResumeThreadCompatible(record, messages, 4000, "selected-thread", nil) {
		t.Fatal("strictly older detached inputs blocked a different explicit known task")
	}
	after, err := json.Marshal(messages)
	if err != nil || string(before) != string(after) || !messages[0].UnknownOutcome || !messages[1].UnknownOutcome {
		t.Fatal("detached-history admission reconciled or rewrote a historical input", err)
	}
	for _, mutate := range []func(*contracts.ChatMessage){
		func(m *contracts.ChatMessage) { m.ExecutorConfirmedAt = contracts.Optional[float64]{} },
		func(m *contracts.ChatMessage) { m.ExecutorConfirmedAt = contracts.Null[float64]() },
		func(m *contracts.ChatMessage) { m.ExecutorConfirmedAt = contracts.Some(float64(2000)) },
		func(m *contracts.ChatMessage) { m.ExecutorConfirmedAt = contracts.Some(float64(800)) },
		func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("bad turn") },
		func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("") },
		func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("selected-turn") },
		func(m *contracts.ChatMessage) { m.TurnID = contracts.Some("previous-turn") },
		func(m *contracts.ChatMessage) { m.QueuedAt = contracts.Some(float64(2000)) },
		func(m *contracts.ChatMessage) { m.ExecutionEndedAt = contracts.Some(float64(2001)) },
	} {
		messages = detachedResumeInputs()
		mutate(messages[0])
		if ResumeEligible(record, messages, 4000) {
			t.Fatal("unproved confirmation, selected lineage or newer activity became detached history")
		}
	}
	for _, turns := range [][]string{{"detached-turn-one"}, {""}} {
		messages = detachedResumeInputs()
		messages = append(messages, &contracts.ChatMessage{ID: "selected-input", Role: contracts.RoleUser, TurnIDs: turns})
		if ResumeEligible(record, messages, 4000) {
			t.Fatal("selected message lineage was ignored or repaired")
		}
	}
}

func TestSelectedResumeThreadCompatibilityRequiresTerminalProofOnlyForTheSameLegacyThread(t *testing.T) {
	record := selectedResumeRecord()
	for _, scenario := range []struct {
		name     string
		thread   json.RawMessage
		terminal []string
		allowed  bool
	}{
		{name: "omitted", allowed: true},
		{name: "null", thread: json.RawMessage(`null`), allowed: true},
		{name: "different", thread: json.RawMessage(`"different-thread"`), allowed: true},
		{name: "same missing", thread: json.RawMessage(`"selected-thread"`)},
		{name: "same wrong turn", thread: json.RawMessage(`"selected-thread"`), terminal: []string{"selected-turn", "unrelated-turn"}},
		{name: "same terminal old turn", thread: json.RawMessage(`"selected-thread"`), terminal: []string{"detached-turn-one"}, allowed: true},
		{name: "object", thread: json.RawMessage(`{}`)},
		{name: "array", thread: json.RawMessage(`[]`)},
		{name: "number", thread: json.RawMessage(`1`)},
		{name: "boolean", thread: json.RawMessage(`false`)},
		{name: "invalid JSON", thread: json.RawMessage(`"unterminated`)},
		{name: "empty", thread: json.RawMessage(`""`)},
		{name: "invalid ID", thread: json.RawMessage(`"bad thread"`)},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			messages := detachedResumeInputs()
			if scenario.thread != nil {
				messages[0].Extra = contracts.RawObject{"threadId": scenario.thread}
			}
			if got := ResumeThreadCompatible(record, messages, 4000, "selected-thread", scenario.terminal); got != scenario.allowed {
				t.Fatal("stored thread or terminal inventory was treated as a different ownership scope", got)
			}
		})
	}
	orphan := historicalResumeUnknown()
	orphan.Extra = contracts.RawObject{"threadId": json.RawMessage(`"selected-thread"`)}
	if ResumeThreadCompatible(record, []*contracts.ChatMessage{orphan}, 4000, "selected-thread", []string{"selected-turn"}) {
		t.Fatal("same-thread unknown input without a turn acquired invented terminal proof")
	}
	messages := detachedResumeInputs()
	messages[0].Time = contracts.Some(float64(2000))
	if ResumeThreadCompatible(record, messages, 4000, "selected-thread", []string{"detached-turn-one"}) {
		t.Fatal("thread metadata bypassed the stored age boundary")
	}
	messages = detachedResumeInputs()
	for _, message := range messages {
		message.Extra = contracts.RawObject{"threadId": json.RawMessage(`"selected-thread"`)}
	}
	if ResumeThreadCompatible(record, messages, 4000, "selected-thread", []string{"detached-turn-one"}) || !ResumeThreadCompatible(record, messages, 4000, "selected-thread", []string{"detached-turn-one", "detached-turn-two"}) {
		t.Fatal("one terminal turn was treated as proof for every same-thread historical input")
	}
	if ResumeThreadCompatible(record, messages, 4000, "", []string{"detached-turn-one", "detached-turn-two"}) {
		t.Fatal("missing current thread identity was replaced with a historical scope")
	}
}

func TestSelectedResumeOtherKnownPausedRecordsRemainIndependentAndUnknownRecordsStillBlock(t *testing.T) {
	selected := selectedResumeRecord()
	first, second := *selectedResumeRecord(), *selectedResumeRecord()
	first.ID, second.ID = "other-known-one", "other-known-two"
	first.TurnID, second.TurnID = "detached-turn-one", "detached-turn-one"
	first.TurnIDs, second.TurnIDs = []string{"detached-turn-one"}, []string{"detached-turn-one"}
	first.StartedAt, second.StartedAt = 500, 500
	first.ExecutionEndedAt, second.ExecutionEndedAt = contracts.Some(float64(1500)), contracts.Some(float64(1500))
	first.MessageID, second.MessageID = contracts.Some("other-known-input-one"), contracts.Some("other-known-input-two")
	first.MessageIDs, second.MessageIDs = nil, nil
	first.UnknownOutcome, second.UnknownOutcome = false, false
	first.Submission, second.Submission = contracts.Optional[contracts.SubmissionStatus]{}, contracts.Optional[contracts.SubmissionStatus]{}
	records := []contracts.WorkRecord{*selected, first, second}
	before, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	if !ResumeOtherWorkKnown(selected.ID, records) || !ResumeEligible(selected, detachedResumeInputs(), 4000) {
		t.Fatal("other known paused records became either a global unknown fence or a selected lineage")
	}
	after, err := json.Marshal(records)
	if err != nil || string(before) != string(after) {
		t.Fatal("checking other known work resumed or rewrote it", err)
	}
	for _, mutate := range []func(*contracts.WorkRecord){
		func(r *contracts.WorkRecord) { r.UnknownOutcome = true },
		func(r *contracts.WorkRecord) { r.Status = contracts.WorkStatusUnknown },
		func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusPreparing) },
		func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusSubmitting) },
		func(r *contracts.WorkRecord) { r.Submission = contracts.Some(contracts.SubmissionStatusUnknown) },
		func(r *contracts.WorkRecord) {
			r.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: Checkpoint(r.Plan), Invalid: true}
		},
	} {
		other := first
		mutate(&other)
		if ResumeOtherWorkKnown(selected.ID, []contracts.WorkRecord{*selected, other}) {
			t.Fatal("another record's unresolved execution was ignored")
		}
	}
}
