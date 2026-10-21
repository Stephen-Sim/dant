package work

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const cancellationSettlementFixtureTimeout = 10 * time.Second

func awaitCancellationSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(cancellationSettlementFixtureTimeout):
		t.Fatal("isolated cancellation coordination did not reach its checkpoint")
	}
}

func awaitCancellationSettlement(t *testing.T, engine *Engine) {
	t.Helper()
	deadline := time.NewTimer(cancellationSettlementFixtureTimeout)
	defer deadline.Stop()
	for !engine.Snapshot().Finishing {
		select {
		case <-deadline.C:
			t.Fatal("isolated cancellation did not begin durable settlement")
		default:
			runtime.Gosched()
		}
	}
}

type unwindingPreparationWorker struct {
	*fakeWorker
	cancelled chan struct{}
	release   <-chan struct{}
}

func (worker *unwindingPreparationWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	result, err := worker.fakeWorker.Request(ctx, method, params)
	if method == "thread/start" && ctx.Err() != nil {
		close(worker.cancelled)
		<-worker.release
	}
	return result, err
}

func TestPreSubmissionCancellationSettlesFromOneActorSnapshotWhilePreparationUnwinds(t *testing.T) {
	for _, pauseOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "pause"}[pauseOnly], func(t *testing.T) {
			engine, persistence, base := engineFixture(t)
			release := make(chan struct{})
			released := false
			defer func() {
				if !released {
					close(release)
				}
			}()
			worker := &unwindingPreparationWorker{
				fakeWorker: base,
				cancelled:  make(chan struct{}),
				release:    release,
			}
			engine.mu.Lock()
			engine.worker = worker
			engine.mu.Unlock()
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "isolated cancellation with concurrent preparation cleanup",
			})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("could not admit isolated preparation", err)
			}
			_ = nextRequest(t, base, "thread/start")

			held := make(chan struct{})
			persisted := make(chan error, 1)
			go func() {
				persisted <- persistence.Mutate(context.Background(), func(*contracts.State) error {
					close(held)
					<-release
					return nil
				})
			}()
			awaitCancellationSignal(t, held)
			cancelled := make(chan error, 1)
			go func() {
				_, err := engine.CancelProgress(context.Background(), ProgressTarget{
					ID: "current", Kind: "active", TurnID: contracts.Null[string](),
					ConversationID: persistence.ConversationID(),
				}, pauseOnly)
				cancelled <- err
			}()
			awaitCancellationSignal(t, worker.cancelled)
			awaitCancellationSettlement(t, engine)
			if state := engine.Snapshot(); !state.Finishing || state.Active == nil || state.Active.TurnID.Value != "" {
				t.Fatal("fixture did not hold cancellation settlement before an executor turn was dispatched")
			}

			// Both the preparation failure and the durable settlement become
			// runnable together; neither owns the other's actor-state reads.
			close(release)
			released = true
			if err := awaitWorkAction(t, persisted); err != nil {
				t.Fatal(err)
			}
			if err := awaitWorkAction(t, cancelled); err != nil {
				t.Fatal(err)
			}
			if err := engine.Close(); err != nil {
				t.Fatal(err)
			}
			stored, err := persistence.Message(message.ID)
			expected := contracts.TaskStatusCancelled
			if pauseOnly {
				expected = contracts.TaskStatusPaused
			}
			if err != nil || stored.Status.Value != contracts.MessageStatus(expected) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || stored.UnknownOutcome || stored.TurnID.Value != "" {
				t.Fatal("concurrent preparation cleanup changed the captured cancellation outcome", err)
			}
			assertWorkerQuiet(t, base)
		})
	}
}
