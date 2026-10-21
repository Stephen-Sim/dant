package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestEmptyVerifiedContinuationAndRetiredPublicationNeverInventChatOutput(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "empty-verified-continuation")
	owner := waitToolScope(t, engine, "empty-verified-continuation")
	arguments := behaviorPlan("Existing work is verified", contracts.PlanStepStatusCompleted)
	arguments["workId"] = raw(workID)
	if _, err := engine.Tool(t.Context(), "task_plan", arguments, owner); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	if id, published, err := engine.publishContinuation(active, contracts.TaskStatusCompleted, contracts.TaskStatusReview); err != nil || published || id != "" || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("empty verified result invented a delivered chat message", err)
	}
	if _, err := engine.archiveExplicit(t.Context(), active, "", nil); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("missing archive capability claimed a file capture", err)
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if _, published, err := engine.publishContinuation(active, contracts.TaskStatusCompleted, contracts.TaskStatusReview); !errors.Is(err, ErrStaleOwner) || published || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("retired publication reused a completed execution owner", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestOutputArchiveThatOutlivesItsTurnDoesNotAttachFilesToRetiredHistory(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	file := deliveryBehaviorFiles(t, 1)[0]
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "late-output-archive")
	engine.options.Deliverables = publicationBoundaryCollector{
		archive: func(context.Context) ([]contracts.Attachment, error) { return nil, nil },
		explicit: func(_ context.Context, input files.ArchiveInput) ([]contracts.Attachment, error) {
			if !input.IsCurrent() {
				t.Fatal("fixture archive was not admitted for its original owner")
			}
			if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
				t.Fatal(err)
			}
			return []contracts.Attachment{file}, nil
		},
	}
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	engine.archiveOutputLinks(t.Context(), active, "[Result](result.txt)")
	if len(persistence.Snapshot().Messages) != 1 || engine.Snapshot().Active != nil || owner.IsCurrent() {
		t.Fatal("late archive attached files or created a delivery after its owner ended")
	}
	assertWorkerQuiet(t, worker)
}
