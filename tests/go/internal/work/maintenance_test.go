package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMaintenanceReservesAdmissionWithoutChangingPauseOrHoldingTheActor(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	engine.paused = true
	err := engine.MaintenanceTransaction(context.Background(), func(ctx context.Context, current func() bool) error {
		if !current() || !engine.MaintenanceActive() || !engine.Snapshot().Executor.Paused {
			t.Fatal("missing idle backup reservation")
		}
		if _, err := engine.AdmitMessage(ctx, persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "not during backup"}); err == nil {
			t.Fatal("message entered reserved execution")
		}
		if _, err := engine.ReserveCallStart(ctx, "call", "api"); err == nil {
			t.Fatal("call entered reserved execution")
		}
		if err := engine.BeginComputerAcquire(); err == nil {
			t.Fatal("human control changed reserved execution")
		}
		if err := engine.ConversationTransaction(ctx, persistence.ConversationID(), func(context.Context) error { t.Fatal("local mutation ran during backup"); return nil }); err == nil {
			t.Fatal("local mutation entered maintenance")
		}
		return nil
	})
	if err != nil || engine.MaintenanceActive() || !engine.Snapshot().Executor.Paused {
		t.Fatal("maintenance leaked or changed the explicit pause preference", err)
	}
}

func TestConcurrentStoreMetadataInvalidatesMaintenanceAndReleasesAfterFailure(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	err := engine.MaintenanceTransaction(context.Background(), func(ctx context.Context, current func() bool) error {
		if !current() {
			t.Fatal("fresh reservation stale")
		}
		if _, err := persistence.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "separate metadata writer"}); err != nil {
			return err
		}
		if current() {
			t.Fatal("backup accepted a state that changed during capture")
		}
		return nil
	})
	if !errors.Is(err, ErrStaleOwner) || engine.MaintenanceActive() {
		t.Fatal("changed capture did not fail closed and release", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = engine.MaintenanceTransaction(ctx, func(context.Context, func() bool) error { cancel(); return ctx.Err() })
	if !errors.Is(err, context.Canceled) || engine.MaintenanceActive() {
		t.Fatal("cancelled backup retained reservation")
	}
}
