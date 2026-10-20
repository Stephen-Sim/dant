package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestUnconfirmedShutdownIsDurableAfterEngineCloseAndCannotReplayOnRestart(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "accepted work"})
	if err != nil {
		t.Fatal(err)
	}
	if err = engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, "accepted-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "accepted-turn"
	})
	if err = engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err = engine.FenceUnconfirmedStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	stored, _ := store.FindMessage(&state, message.ID)
	if !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || !unconfirmedState(state) {
		t.Fatal("accepted execution was classified as stopped without proof")
	}

	restarted, err := New(context.Background(), persistence, worker, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if !restarted.Snapshot().Executor.Paused || restarted.CanContinueRegisteredWork() {
		t.Fatal("restart removed an unconfirmed process fence")
	}
	if _, err := restarted.ResumePaused(context.Background(), []string{message.ID}, ResumeOptions{}); !errors.Is(err, ErrUnknown) {
		t.Fatal("unconfirmed work resumed without explicit stop reconciliation", err)
	}
	if err = restarted.ConfirmStopped(context.Background()); !errors.Is(err, ErrUnknown) {
		t.Fatal("fresh process incorrectly vouched for a previous executor", err)
	}
	if _, err := restarted.Thread(context.Background()); !errors.Is(err, ErrUnknown) {
		t.Fatal("inherited stop fence allowed a thread handshake", err)
	}
	if _, err := restarted.ReserveCallStart(context.Background(), "new-call", "api"); !errors.Is(err, ErrUnknown) {
		t.Fatal("inherited stop fence allowed call admission", err)
	}
	if err = engine.ConfirmStopped(context.Background()); err != nil {
		t.Fatal("same-process positive stop proof was rejected", err)
	}
	if _, present := persistence.Snapshot().Extra[executorStopFenceKey]; present {
		t.Fatal("positive executor stop proof did not clear its shutdown fence")
	}
	select {
	case request := <-worker.requests:
		t.Fatalf("stop reconciliation replayed work: %s", request.method)
	default:
	}
}

func TestShutdownFencePreservesCompletedEvidenceAndSurvivesPersistenceReopen(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	completed, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "finished", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusReview)), Submission: contracts.Some(contracts.SubmissionStatusConfirmed)})
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := engine.FenceUnconfirmedStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, _ := persistence.Message(completed.ID)
	if stored.UnknownOutcome || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) {
		t.Fatal("shutdown invented uncertainty for an already terminal turn")
	}
	reopened, err := store.Open(persistence.Directory(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !unconfirmedState(reopened.Snapshot()) {
		t.Fatal("persistent standalone fence was lost on reopen")
	}
}
