package controller

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controllerDesktopBridge struct {
	*desktopBridgeFixture
	connect func(context.Context, bool) error
	refresh func(context.Context) (contracts.WorkerSnapshot, error)
}

func (bridge *controllerDesktopBridge) Connect(ctx context.Context, deploy bool) error {
	if bridge.connect != nil {
		return bridge.connect(ctx, deploy)
	}
	return bridge.desktopBridgeFixture.Connect(ctx, deploy)
}

func (bridge *controllerDesktopBridge) Refresh(ctx context.Context) (contracts.WorkerSnapshot, error) {
	if bridge.refresh != nil {
		return bridge.refresh(ctx)
	}
	return bridge.desktopBridgeFixture.Refresh(ctx)
}

type controllerDesktopPower struct {
	*desktopPowerFixture
	resume     func(context.Context) (computer.ResumeResult, error)
	reconnects int
}

func (power *controllerDesktopPower) Resume(ctx context.Context) (computer.ResumeResult, error) {
	if power.resume != nil {
		return power.resume(ctx)
	}
	return power.desktopPowerFixture.Resume(ctx)
}

func (power *controllerDesktopPower) ResumeForReconnect(ctx context.Context) (computer.ResumeResult, error) {
	power.reconnects++
	return power.Resume(ctx)
}

func TestControllerDesktopPrepareRespectsManagedResumeOwnershipAndRechecksPause(t *testing.T) {
	for _, options := range []PrepareOptions{{}, {RecoverManagedVM: true}, {ManagedVMAlreadyRestored: true}} {
		bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOffline, state: controllerQuiescentState(contracts.ConnectionStatusOnline)}
		power := &controllerDesktopPower{desktopPowerFixture: &desktopPowerFixture{}}
		desktop := NewDesktopLifecycle(DesktopOptions{
			Bridge: bridge, Lifecycle: power,
			Binding: func() string { return "isolated-binding" }, Configured: func() bool { return true },
		})
		result, err := desktop.Prepare(context.Background(), options)
		if err != nil || !result.OK || !result.WorkPaused || desktop.Phase() != contracts.DesktopPhasePaused || bridge.connected != 1 || bridge.paused != 1 || power.suspended != 0 {
			t.Fatal("preparation failed to connect and pause before installation")
		}
		wantResume := 1
		if options.ManagedVMAlreadyRestored {
			wantResume = 0
		}
		if power.resumed != wantResume || (power.reconnects == 1) != options.RecoverManagedVM {
			t.Fatal("preparation repeated or selected the wrong managed resume operation")
		}
		if _, err := desktop.Prepare(context.Background(), options); err != nil || bridge.paused != 1 {
			t.Fatal("already paused desktop repeated a worker pause instead of revalidating")
		}
		bridge.state.Queue = []string{"new-unfinished-work"}
		if _, err := desktop.Prepare(context.Background(), options); !errors.Is(err, ErrDesktopBusy) || desktop.Phase() != contracts.DesktopPhaseIdle {
			t.Fatal("previous pause was trusted after new work appeared")
		}
		desktop.Close()
	}
}

func TestControllerDesktopPreparationRejectsUnconfirmedRefreshAndIdentityChanges(t *testing.T) {
	for _, fixture := range []struct {
		name          string
		refreshError  error
		changeBinding bool
		queued        bool
	}{
		{"refresh unavailable", computer.ErrBridgeOffline, false, false},
		{"binding retired", nil, true, false},
		{"queue unfinished", nil, false, true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			identity := "captured"
			bridge := &controllerDesktopBridge{desktopBridgeFixture: &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOffline)}}
			bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
				if fixture.changeBinding {
					identity = "replacement"
				}
				state := bridge.state
				if fixture.queued {
					state.Queue = []string{"pending"}
				}
				return state, fixture.refreshError
			}
			power := &desktopPowerFixture{}
			desktop := NewDesktopLifecycle(DesktopOptions{Bridge: bridge, Lifecycle: power, Binding: func() string { return identity }, Configured: func() bool { return true }})
			defer desktop.Close()
			if _, err := desktop.Prepare(context.Background(), PrepareOptions{}); err == nil || power.suspended != 0 || bridge.paused != 0 || desktop.Blocked() {
				t.Fatal("unconfirmed stopped worker was treated as safe for installation")
			}
		})
	}
}

func TestControllerDesktopCancelRejectsRetiredOwnersAndJoinsNoAutomaticWork(t *testing.T) {
	for _, fixture := range []struct {
		name            string
		resumeError     error
		connectError    error
		changeOnResume  bool
		changeOnConnect bool
	}{
		{"resume unconfirmed", context.DeadlineExceeded, nil, false, false},
		{"connect unavailable", nil, computer.ErrBridgeOffline, false, false},
		{"binding changed before connect", nil, nil, true, false},
		{"binding changed after connect", nil, nil, false, true},
		{"confirmed cancellation", nil, nil, false, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			identity := "captured"
			bridge := &controllerDesktopBridge{desktopBridgeFixture: &desktopBridgeFixture{status: contracts.ConnectionStatusOffline}}
			power := &controllerDesktopPower{desktopPowerFixture: &desktopPowerFixture{}}
			power.resume = func(context.Context) (computer.ResumeResult, error) {
				power.resumed++
				if fixture.changeOnResume {
					identity = "replacement"
				}
				return computer.ResumeResult{OK: fixture.resumeError == nil}, fixture.resumeError
			}
			bridge.connect = func(context.Context, bool) error {
				bridge.connected++
				if fixture.changeOnConnect {
					identity = "replacement"
				}
				return fixture.connectError
			}
			desktop := NewDesktopLifecycle(DesktopOptions{Bridge: bridge, Lifecycle: power, Binding: func() string { return identity }, Configured: func() bool { return true }})
			defer desktop.Close()
			result, err := desktop.Cancel(context.Background(), false)
			wantSuccess := fixture.resumeError == nil && fixture.connectError == nil && !fixture.changeOnResume && !fixture.changeOnConnect
			if (err == nil) != wantSuccess || result.OK != wantSuccess || desktop.Blocked() || power.suspended != 0 || bridge.paused != 0 {
				t.Fatal("cancel-exit accepted an unconfirmed owner or resumed task execution")
			}
			if (fixture.resumeError != nil || fixture.changeOnResume) && bridge.connected != 0 {
				t.Fatal("cancel-exit connected after managed power ownership was lost")
			}
		})
	}
}

func TestControllerDesktopRejectsConcurrentTransitionsAndInvalidPhases(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	bridge := &desktopBridgeFixture{
		status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOnline),
		pause: func() { close(entered); <-release },
	}
	power := &desktopPowerFixture{}
	desktop := NewDesktopLifecycle(DesktopOptions{Bridge: bridge, Lifecycle: power, Binding: func() string { return "same" }, Configured: func() bool { return true }})
	defer desktop.Close()
	if err := desktop.SetPhase(contracts.DesktopPhase("invalid")); !errors.Is(err, ErrDesktopBusy) || desktop.Blocked() {
		t.Fatal("invalid phase replaced the desktop state")
	}
	done := make(chan error, 1)
	go func() { _, err := desktop.Prepare(context.Background(), PrepareOptions{}); done <- err }()
	<-entered
	if _, err := desktop.Cancel(context.Background(), true); !errors.Is(err, ErrDesktopBusy) {
		close(release)
		<-done
		t.Fatal("overlapping desktop transition was admitted")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	desktop.Close()
	if err := desktop.SetPhase(contracts.DesktopPhaseIdle); !errors.Is(err, ErrDesktopBusy) {
		t.Fatal("closed desktop state was mutated")
	}
}
