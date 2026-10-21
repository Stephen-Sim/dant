package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type publicationBoundaryCollector struct {
	archive  func(context.Context) ([]contracts.Attachment, error)
	explicit func(context.Context, files.ArchiveInput) ([]contracts.Attachment, error)
}

func (publicationBoundaryCollector) CaptureBaseline(context.Context, string) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func (collector publicationBoundaryCollector) Archive(ctx context.Context, _ string, _ string, _ json.RawMessage) ([]contracts.Attachment, error) {
	return collector.archive(ctx)
}

func (collector publicationBoundaryCollector) ArchiveExplicit(ctx context.Context, input files.ArchiveInput) ([]contracts.Attachment, error) {
	return collector.explicit(ctx, input)
}

func TestArchiveFailuresPublishFixedNoticesAndNeverExposeRawFileErrors(t *testing.T) {
	for _, phase := range []string{"final archive", "explicit archive", "final attach", "explicit attach"} {
		t.Run(phase, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			failure := errors.New("synthetic-private-file-content")
			collector := publicationBoundaryCollector{
				archive: func(context.Context) ([]contracts.Attachment, error) {
					if phase == "final archive" {
						return nil, failure
					}
					return []contracts.Attachment{{}}, nil
				},
				explicit: func(_ context.Context, input files.ArchiveInput) ([]contracts.Attachment, error) {
					if input.IsCurrent == nil || !input.IsCurrent() || !input.OnlyExplicit {
						t.Error("archive lost the exact execution guard")
					}
					if phase == "explicit archive" {
						return nil, failure
					}
					return []contracts.Attachment{{}}, nil
				},
			}
			engine.options.Deliverables = collector
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "archive-failure-turn")
			signals, unsubscribe, err := engine.SubscribeSignals()
			if err != nil {
				t.Fatal(err)
			}
			defer unsubscribe()
			if strings.HasPrefix(phase, "explicit") {
				if _, err := engine.DeliverText(t.Context(), "[Synthetic result](result.txt)", owner); err != nil {
					t.Fatal("committed text delivery lost its separate archive classification", err)
				}
			} else {
				engine.mu.Lock()
				active := engine.active
				engine.mu.Unlock()
				engine.archiveFinalOutputs(active)
			}
			signal := <-signals
			if signal.Type != "notice" || strings.Contains(string(signal.Data), failure.Error()) || !strings.Contains(string(signal.Data), "output files could not be added") || !owner.IsCurrent() {
				t.Fatal("archive failure exposed file content or replaced the current execution")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestQuietPublicationWriteFailuresRetainBufferedFilesForTheirOwningWork(t *testing.T) {
	for _, phase := range []string{"message", "attachment"} {
		t.Run(phase, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				for _, message := range state.Messages {
					if message.Role == contracts.RoleAssistant && (phase == "message" || len(message.Attachments) > 0) {
						return true
					}
				}
				return false
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			workID, prior := savedUnfinished(t, persistence)
			continueFixture(t, engine, worker, workID, prior, "quiet-publication-failure-turn")
			owner := waitToolScope(t, engine, "quiet-publication-failure-turn")
			plan := behaviorPlan("Verified synthetic publication", contracts.PlanStepStatusCompleted)
			plan["workId"] = raw(workID)
			if _, err := engine.Tool(t.Context(), "task_plan", plan, owner); err != nil {
				t.Fatal(err)
			}
			if _, err := engine.DeliverText(t.Context(), "Verified result", owner); err != nil {
				t.Fatal(err)
			}
			if _, err := engine.DeliverAttachments(t.Context(), deliveryBehaviorFiles(t, 1), owner); err != nil {
				t.Fatal(err)
			}
			engine.mu.Lock()
			active := engine.active
			engine.mu.Unlock()
			fault.armed.Store(true)
			if _, sent, err := engine.publishContinuation(active, contracts.TaskStatusCompleted, contracts.TaskStatusReview); sent || !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 {
				t.Fatal("unconfirmed quiet publication claimed successful delivery", err)
			}
			engine.mu.Lock()
			retained := len(engine.quietFiles[workID])
			engine.mu.Unlock()
			if retained != 1 || phase == "message" && len(persistence.Snapshot().Messages) != 0 || phase == "attachment" && (len(persistence.Snapshot().Messages) != 1 || len(persistence.Snapshot().Messages[0].Attachments) != 0) {
				t.Fatal("failed publication discarded buffered files or invented a committed attachment")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
