package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestConnectionMutationReservesAdmissionWithoutHoldingActorOrClearingPause(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	engine.mu.Lock()
	engine.paused = true
	engine.mu.Unlock()
	entered, release := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- engine.ConnectionTransaction(context.Background(), false, func(context.Context) error { close(entered); <-release; return nil })
	}()
	<-entered
	if !engine.Snapshot().Executor.Paused {
		t.Fatal("connection reservation cleared user pause")
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "racing input"}); err == nil {
		t.Fatal("new task slipped between idle connection check and RPC")
	}
	if _, err := engine.ReserveCallStart(context.Background(), "racing-call", "api"); err == nil {
		t.Fatal("voice handshake bypassed connection reservation")
	}
	if err := engine.BeginComputerAcquire(); err == nil {
		t.Fatal("computer takeover bypassed connection reservation")
	}
	if err := engine.ConnectionTransaction(context.Background(), false, func(context.Context) error { t.Fatal("second connection mutation ran"); return nil }); !errors.Is(err, ErrBusy) {
		t.Fatal("connection mutation overlapped", err)
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if !engine.Snapshot().Executor.Paused || engine.MaintenanceActive() || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("reservation release changed pause, admitted a rejected message, or left stale maintenance")
	}
}

func TestConnectionMutationRetainsUnknownFailureAndReleasesReservationOnce(t *testing.T) {
	engine, _, _ := engineFixture(t)
	called := 0
	if err := engine.ConnectionTransaction(context.Background(), true, func(context.Context) error { called++; return ErrUnknown }); !errors.Is(err, ErrUnknown) {
		t.Fatal("unknown connection result was normalized", err)
	}
	if called != 1 || engine.MaintenanceActive() {
		t.Fatal("connection mutation retried or leaked its reservation")
	}
	if err := engine.FenceUnconfirmedStop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := engine.ConnectionTransaction(context.Background(), false, func(context.Context) error { called++; return nil }); !errors.Is(err, ErrUnknown) || called != 1 {
		t.Fatal("unconfirmed old executor allowed a new connection", err)
	}
}
