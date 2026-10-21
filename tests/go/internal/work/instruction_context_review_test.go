package work

import (
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestInstructionRefreshIncludesReviewWorkAsReferenceWithoutStartingAnExecutor(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "review-reference-turn", Source: "chat", Title: "Verified work awaiting human review", Observed: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(t.Context(), record.TurnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusReview), ExecutionEnded: true, At: engine.Timestamp()}); err != nil {
		t.Fatal(err)
	}
	before := persistence.Revision()
	instructions, err := engine.InstructionsContext(t.Context())
	if err != nil || !strings.Contains(instructions, record.ID) || !strings.Contains(instructions, record.Title) || !strings.Contains(instructions, string(contracts.WorkStatusReview)) || persistence.Revision() != before || engine.Snapshot().Active != nil {
		t.Fatal("review references were omitted, changed saved work, or started another executor", err)
	}
	assertWorkerQuiet(t, worker)
}
