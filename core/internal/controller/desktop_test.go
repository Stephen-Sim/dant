package controller

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type desktopBridgeFixture struct {
	status       contracts.ConnectionStatus
	state        contracts.WorkerSnapshot
	paused       int
	disconnected int
	connected    int
	pause        func()
}

func (bridge *desktopBridgeFixture) Status() contracts.ConnectionStatus { return bridge.status }
func (bridge *desktopBridgeFixture) Snapshot() contracts.WorkerSnapshot { return bridge.state }
func (bridge *desktopBridgeFixture) Connect(context.Context, bool) error {
	bridge.connected++
	bridge.status = contracts.ConnectionStatusOnline
	return nil
}

func (bridge *desktopBridgeFixture) Refresh(context.Context) (contracts.WorkerSnapshot, error) {
	return bridge.state, nil
}

func (bridge *desktopBridgeFixture) PauseWorkForUpdate(context.Context, string) error {
	bridge.paused++
	if bridge.pause != nil {
		bridge.pause()
	}

	return nil
}

func (bridge *desktopBridgeFixture) Disconnect() {
	bridge.disconnected++
	bridge.status = contracts.ConnectionStatusOffline
}

type desktopPowerFixture struct {
	suspended int
	resumed   int
	supported bool
}

func (power *desktopPowerFixture) Suspend(context.Context) (computer.SuspendResult, error) {
	power.suspended++
	return computer.SuspendResult{OK: true, Supported: power.supported, VMSuspended: power.supported}, nil
}

func (power *desktopPowerFixture) Resume(context.Context) (computer.ResumeResult, error) {
	power.resumed++
	return computer.ResumeResult{OK: true}, nil
}

func (power *desktopPowerFixture) ResumeForReconnect(ctx context.Context) (computer.ResumeResult, error) {
	return power.Resume(ctx)
}

func TestExplicitExitPausesBeforePowerAndNormalCloseDoesNeither(t *testing.T) {
	bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: contracts.WorkerSnapshot{Worker: contracts.WorkerState{Status: contracts.ConnectionStatusOnline}}}
	power := &desktopPowerFixture{supported: true}
	desktop := NewDesktopLifecycle(DesktopOptions{Bridge: bridge, Lifecycle: power, Binding: func() string { return "fixture-binding" }, Configured: func() bool { return true }})
	result, err := desktop.Exit(context.Background())
	if err != nil || result.VMSuspended == nil || !*result.VMSuspended || bridge.paused != 1 || power.suspended != 1 || bridge.disconnected != 1 || desktop.Phase() != contracts.DesktopPhaseSuspended {
		t.Fatal("explicit exit did not coordinate pause/power")
	}
	beforePause, beforePower := bridge.paused, power.suspended
	desktop.Close()
	if bridge.paused != beforePause || power.suspended != beforePower {
		t.Fatal("normal close operated the VM")
	}

	if _, err := desktop.Cancel(context.Background(), false); !errors.Is(err, ErrDesktopBusy) {
		t.Fatal("closed coordinator admitted transition")
	}
}

func TestDesktopTransitionRejectsStaleBindingBeforePower(t *testing.T) {
	identity := "first"
	bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: contracts.WorkerSnapshot{Worker: contracts.WorkerState{Status: contracts.ConnectionStatusOnline}}, pause: func() { identity = "second" }}
	power := &desktopPowerFixture{supported: true}
	desktop := NewDesktopLifecycle(DesktopOptions{Bridge: bridge, Lifecycle: power, Binding: func() string { return identity }, Configured: func() bool { return true }})
	defer desktop.Close()
	if _, err := desktop.Exit(context.Background()); !errors.Is(err, ErrDesktopBusy) || power.suspended != 0 || desktop.Phase() != contracts.DesktopPhaseIdle {
		t.Fatal("stale transition applied to another VM")
	}
}
