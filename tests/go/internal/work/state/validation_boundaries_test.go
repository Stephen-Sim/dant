package state

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestPlanBoundaryRejectsInvalidAndFullyRedactedInputs(t *testing.T) {
	valid := func() contracts.RawObject {
		return contracts.RawObject{"title": json.RawMessage(`"Task"`), "steps": json.RawMessage(`[{"step":"remaining","status":"pending"}]`)}
	}
	for _, test := range []struct {
		key string
		raw string
	}{{"unknown", `true`}, {"title", `null`}, {"title", `""`}, {"steps", `false`}, {"steps", `[]`}, {"steps", `[{"step":"","status":"pending"}]`}, {"steps", `[{"step":"remaining","status":"unknown"}]`}, {"status", `"paused"`}, {"workId", `"bad id"`}} {
		input := valid()
		input[test.key] = json.RawMessage(test.raw)
		if _, err := ReadPlanInput(input, nil); err == nil {
			t.Fatal("invalid public plan was admitted")
		}
	}
	if _, err := ReadPlanInput(valid(), func(string) string { return "" }); err == nil {
		t.Fatal("fully redacted plan retained a visible title")
	}
	if _, err := PublicPlan([]contracts.PlanStep{{Step: "secret", Status: contracts.PlanStepStatusPending}}, func(string) string { return "" }); err == nil {
		t.Fatal("fully redacted step was retained")
	}
	plan, err := PublicPlan([]contracts.PlanStep{{Step: "\t first\x00 step \n", Status: contracts.PlanStepStatusPending}, {Step: " second ", Status: contracts.PlanStepStatusInProgress}}, func(text string) string { return strings.ReplaceAll(text, "second", "visible") })
	if err != nil || plan.Steps[0].Step != "first  step" || plan.CurrentStep != "visible" || plan.Total != 2 {
		t.Fatal("public plan did not sanitize control characters and choose active step", plan, err)
	}
	input := valid()
	input["workId"] = json.RawMessage(`"existing-work"`)
	input["status"] = json.RawMessage(`"waiting_user"`)
	parsed, err := ReadPlanInput(input, nil)
	if err != nil || parsed.WorkID != "existing-work" || parsed.Status.Value != contracts.WorkStatusWaitingUser || parsed.Plan.Total != 1 {
		t.Fatal("valid waiting-user plan did not retain its work owner", parsed, err)
	}
	if Checkpoint(&plan) == Checkpoint(nil) {
		t.Fatal("multi-step checkpoint lost its ordered plan")
	}
}

func TestContinuationBoundaryRejectsMalformedOwnershipAndNeverMutatesCompletedPlans(t *testing.T) {
	plan := &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "verified", Status: contracts.PlanStepStatusCompleted}}, Completed: 1, Total: 1}
	valid := func() *contracts.WorkContinuation {
		return &contracts.WorkContinuation{NextAt: contracts.Some(float64(1000)), LastCheckpoint: Checkpoint(plan), Dispatch: &contracts.ContinuationDispatch{ID: "attempt", FromTurnID: "old", ThreadID: "thread", RuntimeID: "vm:fixture", CreatedAt: 1000, Phase: contracts.ContinuationDispatchPhaseAcknowledged, TurnID: "new"}}
	}
	if !SafeContinuation(valid()) {
		t.Fatal("valid acknowledged continuation was rejected")
	}
	if SafeContinuation(nil) || Eligible(nil, 2000) || !Unfinished(&contracts.WorkRecord{Provisional: true}) {
		t.Fatal("missing continuation or provisional work was classified incorrectly")
	}
	for _, mutate := range []func(*contracts.WorkContinuation){
		func(c *contracts.WorkContinuation) { c.LastCheckpoint = strings.Repeat("z", 64) },
		func(c *contracts.WorkContinuation) { c.Invalid = true },
		func(c *contracts.WorkContinuation) { c.Dispatch.ID = "" },
		func(c *contracts.WorkContinuation) { c.Dispatch.RuntimeID = "vm\x00fixture" },
		func(c *contracts.WorkContinuation) { c.Dispatch.TurnID = "" },
		func(c *contracts.WorkContinuation) { c.Dispatch.TurnID = "old" },
		func(c *contracts.WorkContinuation) { c.Dispatch.Phase = contracts.ContinuationDispatchPhaseSubmitting },
	} {
		continuation := valid()
		mutate(continuation)
		if SafeContinuation(continuation) {
			t.Fatal("malformed continuation ownership was accepted")
		}
	}
	for _, record := range []*contracts.WorkRecord{nil, {Plan: &contracts.TaskPlan{}}, {Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "bad", Status: "unknown"}}}}, {Plan: plan}} {
		if Unfinished(record) {
			t.Fatal("invalid or completed plan became unfinished")
		}
	}
	record := &contracts.WorkRecord{ID: "work", TurnID: "turn", Status: contracts.WorkStatusCompleted, Plan: plan, ExecutionEndedAt: contracts.Some(float64(1000))}
	if !ReplyEligible(record, 2000) || plan.Steps[0].Status != contracts.PlanStepStatusCompleted || plan.Completed != 1 {
		t.Fatal("human reply eligibility rewrote the saved completed plan")
	}
	record.Status = contracts.WorkStatusRunning
	if ReplyEligible(record, 2000) {
		t.Fatal("active work was eligible for another reply execution")
	}
	if SliceText("bounded", 4) != "boun" || SliceText("short", 10) != "short" {
		t.Fatal("public projection did not retain its text bound")
	}
}
