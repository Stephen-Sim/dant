package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRestartRestoresMessageStatesWithoutInventingAcknowledgement(t *testing.T) {
	for _, test := range []struct {
		name, raw string
		want      contracts.MessageStatus
	}{
		{"read task", `{"id":"message","role":"user","status":"read","progressPriority":"future"}`, contracts.MessageStatus(contracts.TaskStatusReview)},
		{"legacy draft", `{"id":"message","role":"user"}`, contracts.MessageStatus(contracts.TaskStatusDraft)},
		{"assistant stream", `{"id":"message","role":"assistant","status":"streaming"}`, contracts.MessageStatus(contracts.TaskStatusPaused)},
	} {
		t.Run(test.name, func(t *testing.T) {
			message, err := restoreMessage([]byte(test.raw), true)
			if err != nil || message == nil || message.Status.Value != test.want || message.ID != "message" {
				t.Fatal("restart changed message identity or durable lifecycle", err)
			}
			if message.Role == contracts.RoleUser && (!message.ExecutorConfirmedAt.Present || !message.ExecutorConfirmedAt.Null) {
				t.Fatal("legacy omission became execution acknowledgement")
			}
			if test.name == "read task" && message.ProgressPriority.Value != contracts.TaskPriorityNormal {
				t.Fatal("unknown display priority did not use the supported default")
			}
		})
	}
	for _, raw := range []string{`null`, `[]`, `{"id":"message","role":"foreign"}`} {
		message, err := restoreMessage([]byte(raw), true)
		if err != nil || message != nil {
			t.Fatal("unrecognized legacy object became a message", err)
		}
	}
	for _, raw := range []string{`{"role":"user"}`, `{"id":"\ud800","role":"user"}`, `{"id":"message","role":"user","turnId":"\ud800"}`} {
		if _, err := restoreMessage([]byte(raw), true); !errors.Is(err, ErrInvalidState) {
			t.Fatal("missing or repaired identity was accepted", err)
		}
	}
}

func TestRestartRestoresContinuationOwnershipAndPreservesUncertainty(t *testing.T) {
	for _, kind := range []string{"invalid structure", "explicit invalid", "claimed", "submitting", "acknowledged", "no progress", "unfinished review", "running", "unknown outcome", "submitting metadata"} {
		t.Run(kind, func(t *testing.T) {
			record := contracts.WorkRecord{
				ID: conversationID, TurnID: "turn", TurnIDs: []string{"turn"}, Source: "chat", Title: "Authored title",
				Status: contracts.WorkStatusContinuing, StartedAt: 100, UpdatedAt: 200,
				Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Finish the remaining result", Status: contracts.PlanStepStatusPending}}, Total: 1},
			}
			want, reason := contracts.WorkStatusUnknown, ""
			switch kind {
			case "invalid structure":
				record.Continuation = &contracts.WorkContinuation{}
				reason = "continuation-state-invalid"
			case "explicit invalid":
				record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: strings.Repeat("a", 64), Invalid: true}
				reason = "continuation-state-invalid"
			case "claimed", "submitting", "acknowledged":
				phase := contracts.ContinuationDispatchPhaseClaimed
				if kind == "submitting" {
					phase = contracts.ContinuationDispatchPhaseSubmitting
				} else if kind == "acknowledged" {
					phase = contracts.ContinuationDispatchPhaseAcknowledged
				}
				dispatch := &contracts.ContinuationDispatch{ID: "attempt", FromTurnID: "turn", RuntimeID: "vm:isolated", ThreadID: "thread", CreatedAt: 100, Phase: phase}
				if kind == "acknowledged" {
					dispatch.TurnID = "current-turn"
					record.TurnID, record.TurnIDs = dispatch.TurnID, []string{"turn", dispatch.TurnID}
				}
				record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Null[float64](), LastCheckpoint: strings.Repeat("a", 64), Attempts: 1, Dispatch: dispatch}
				want, reason = contracts.WorkStatusPaused, "continuation-interrupted"
				if kind == "submitting" {
					want, reason = contracts.WorkStatusUnknown, "continuation-unconfirmed"
				}
			case "no progress":
				record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(float64(1000)), LastCheckpoint: strings.Repeat("a", 64), Attempts: 3, NoProgressCount: 3}
				want, reason = contracts.WorkStatusPaused, "automatic-no-progress"
			case "unfinished review":
				record.Status = contracts.WorkStatusReview
				want = contracts.WorkStatusContinuing
			case "running":
				record.Status = contracts.WorkStatusRunning
				want, reason = contracts.WorkStatusPaused, "restart"
			case "unknown outcome":
				record.UnknownOutcome = true
			case "submitting metadata":
				record.Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
			}
			raw, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := restoreWorkRecord(raw, true)
			if err != nil || restored == nil || restored.ID != record.ID || restored.TurnID != record.TurnID || restored.StartedAt != 100 || restored.UpdatedAt != 200 || restored.Status != want || restored.PauseReason.Value != reason {
				t.Fatal("restart changed exact ownership, timestamps or uncertainty", kind, err, restored)
			}
			if kind == "submitting metadata" && restored.Submission.Value != contracts.SubmissionStatusUnknown {
				t.Fatal("unacknowledged submission became safely replayable")
			}
			if kind == "no progress" && !restored.Continuation.NextAt.Null {
				t.Fatal("paused no-progress work remained scheduled")
			}
		})
	}
}

func TestRestoreRefusesInvalidConversationAndNestedIdentityFields(t *testing.T) {
	for _, raw := range []string{
		`null`, `[]`, `{"conversationId":"invalid"}`, `{"conversationId":"\ud800"}`,
		`{"threadId":"\ud800"}`, `{"messages":[{"role":"user"}]}`,
		`{"workTasks":[{"turnId":"turn"}]}`,
	} {
		if _, err := restore([]byte(raw), func() string { return conversationID }, true); !errors.Is(err, ErrInvalidState) {
			t.Fatal("invalid persisted identity accepted", raw, err)
		}
	}
	if _, err := restore([]byte(`{}`), func() string { return "invalid" }, true); !errors.Is(err, ErrInvalidState) {
		t.Fatal("invalid allocated conversation accepted", err)
	}
	for _, raw := range []string{`null`, `{"id":"invalid","turnId":"turn","source":"chat"}`, `{"id":"` + conversationID + `","turnId":"turn","source":"chat","title":" ","plan":{}}`} {
		if work, err := restoreWorkRecord([]byte(raw), true); err != nil || work != nil {
			t.Fatal("unrecognized legacy object became executable work", err)
		}
	}
	for _, field := range []string{"turnIds", "messageId", "taskId"} {
		raw := `{"id":"` + conversationID + `","turnId":"turn","source":"chat","` + field + `":"\ud800"}`
		if _, err := restoreWorkRecord([]byte(raw), true); !errors.Is(err, ErrInvalidState) {
			t.Fatal("damaged nested execution identity accepted", field, err)
		}
	}
}
