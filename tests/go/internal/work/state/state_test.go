package state

import (
	"bytes"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"strings"
	"testing"
)

func TestPlanValidationRetainsUTF16AndWaitingUserRules(t *testing.T) {
	for _, steps := range []string{`[{"step":"do work","status":"inProgress"}]`, `[{"step":"verified","status":"completed"}]`} {
		_, err := ReadPlanInput(contracts.RawObject{"title": json.RawMessage(`"real task"`), "status": json.RawMessage(`"waiting_user"`), "steps": json.RawMessage(steps)}, nil)
		if err == nil {
			t.Fatal("invalid waiting_user checklist accepted")
		}
	}
	step := contracts.PlanStep{Step: strings.Repeat("a", 239) + "😀", Status: contracts.PlanStepStatusPending}
	plan, err := PublicPlan([]contracts.PlanStep{step}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`\ud83d`)) || bytes.Contains(raw, []byte(`\ufffd`)) {
		t.Fatal("UTF-16 slice boundary was repaired and lost")
	}
	var decoded contracts.TaskPlan
	if json.Unmarshal(raw, &decoded) != nil {
		t.Fatal("persisted plan invalid")
	}
	if Checkpoint(&decoded) != Checkpoint(&plan) {
		t.Fatal("checkpoint changed after persisted roundtrip")
	}
}

func TestContinuationEligibilityNeverRetriesUnknownOrDispatchedWork(t *testing.T) {
	plan, _ := PublicPlan([]contracts.PlanStep{{Step: "finish", Status: contracts.PlanStepStatusPending}}, nil)
	record := contracts.WorkRecord{ID: "work", TurnID: "turn", Status: contracts.WorkStatusContinuing, Plan: &plan, ExecutionEndedAt: contracts.Some(1000.0)}
	if Eligible(&record, 5999) || !Eligible(&record, 6000) {
		t.Fatal("initial continuation fence changed")
	}
	record.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(6000.0), LastCheckpoint: Checkpoint(&plan)}
	if !Eligible(&record, 6000) {
		t.Fatal("valid persisted continuation rejected")
	}
	record.Continuation.Dispatch = &contracts.ContinuationDispatch{ID: "attempt", FromTurnID: "turn", RuntimeID: "vm:one", ThreadID: "thread", Phase: contracts.ContinuationDispatchPhaseSubmitting, CreatedAt: 6000}
	if Eligible(&record, 9000) || !Unconfirmed(&record) || ReplyEligible(&record, 9000) {
		t.Fatal("unknown external action became replayable")
	}
	record.Continuation.Dispatch = nil
	record.Continuation.NoProgressCount = 3
	record.Continuation.Attempts = 3
	if Eligible(&record, 9000) {
		t.Fatal("no-progress breaker ignored")
	}
	if Delay(0) != 30000 || Delay(3) != 120000 || Delay(50) != 300000 {
		t.Fatal("continuation timing policy changed")
	}
}

func TestCheckpointPreservesCanonicalJSONDigestAndUnicode(t *testing.T) {
	for _, fixture := range []struct {
		raw, want string
	}{
		{`null`, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"},
		{`[{"step":"<literal>\u2028\u2029😀","status":"pending"}]`, "9e97fcd135a23965ea2cd69bc54a4afc76f711439ec9a43cd2e27fafd5e036dc"},
		{`[{"step":"legacy\ud800","status":"completed"}]`, "d9512b4daef73ba158c67cdb83754d8fd23ad9b582b72abaaa912cf6e3abeeb8"},
		{`[{"step":"slash\\u2028","status":"inProgress"}]`, "e25b9579030b19b5168ca96e3ca9c2b9f400afca609f5340a1be76eb330b2842"},
	} {
		var plan *contracts.TaskPlan
		if fixture.raw != "null" {
			plan = &contracts.TaskPlan{}
			if err := json.Unmarshal([]byte(fixture.raw), &plan.Steps); err != nil {
				t.Fatal(err)
			}
		}
		if got := Checkpoint(plan); got != fixture.want {
			t.Fatalf("checkpoint mismatch: got %s", got)
		}
	}
}
