package controller

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDesktopPausedProofAndConnectionFailuresCannotAdvanceToPowerOperations(t *testing.T) {
	for _, mode := range []string{"cancelled", "paused-refresh-failed", "paused-owner-changed", "owner-changed-on-phase", "connect-failed", "owner-changed-after-connect", "prepare-resume-failed", "prepare-owner-changed"} {
		t.Run(mode, func(t *testing.T) {
			identity := "captured-owner"
			bridge := &controllerDesktopBridge{desktopBridgeFixture: &desktopBridgeFixture{
				status: contracts.ConnectionStatusOnline,
				state:  controllerQuiescentState(contracts.ConnectionStatusOnline),
			}}
			power := &controllerDesktopPower{desktopPowerFixture: &desktopPowerFixture{supported: true}}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "cancelled":
				cancel()
			case "paused-refresh-failed":
				bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
					return contracts.WorkerSnapshot{}, computer.ErrBridgeOffline
				}
			case "paused-owner-changed":
				bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
					identity = "replacement-owner"
					return bridge.state, nil
				}
			case "connect-failed", "owner-changed-after-connect", "prepare-resume-failed", "prepare-owner-changed":
				bridge.status = contracts.ConnectionStatusOffline
				bridge.connect = func(context.Context, bool) error {
					bridge.connected++
					if mode == "connect-failed" {
						return computer.ErrBridgeOffline
					}
					if mode == "owner-changed-after-connect" {
						identity = "replacement-owner"
					}
					bridge.status = contracts.ConnectionStatusOnline
					return nil
				}
				power.resume = func(context.Context) (computer.ResumeResult, error) {
					power.resumed++
					if mode == "prepare-resume-failed" {
						return computer.ResumeResult{}, context.DeadlineExceeded
					}
					if mode == "prepare-owner-changed" {
						identity = "replacement-owner"
					}
					return computer.ResumeResult{OK: true}, nil
				}
			}
			var desktop *DesktopLifecycle
			desktop = NewDesktopLifecycle(DesktopOptions{
				Bridge: bridge, Lifecycle: power,
				Binding: func() string { return identity }, Configured: func() bool { return true },
				Changed: func() {
					if mode == "owner-changed-on-phase" && desktop.Phase() == contracts.DesktopPhasePausing {
						identity = "replacement-owner"
					}
				},
			})
			defer desktop.Close()
			if mode == "paused-refresh-failed" || mode == "paused-owner-changed" {
				if err := desktop.SetPhase(contracts.DesktopPhasePaused); err != nil {
					t.Fatal(err)
				}
			}
			result, err := desktop.Prepare(ctx, PrepareOptions{})
			if err == nil || result.OK || power.suspended != 0 || bridge.paused != 0 || desktop.Blocked() {
				t.Fatal("unconfirmed desktop preparation crossed the pause or power boundary", err)
			}
			if mode == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("preparation discarded caller cancellation", err)
			}
			if (mode == "prepare-resume-failed" || mode == "prepare-owner-changed") && bridge.connected != 0 {
				t.Fatal("failed managed resume still started a connection")
			}
		})
	}
}

type retiringDesktopPower struct {
	*desktopPowerFixture
	afterSuspend func()
}

func (power *retiringDesktopPower) Suspend(ctx context.Context) (computer.SuspendResult, error) {
	result, err := power.desktopPowerFixture.Suspend(ctx)
	power.afterSuspend()
	return result, err
}

func TestDesktopRetiredAfterSuspensionCannotDisconnectAReplacementBinding(t *testing.T) {
	identity := "original-owner"
	bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOnline)}
	power := &retiringDesktopPower{desktopPowerFixture: &desktopPowerFixture{supported: true}}
	desktop := NewDesktopLifecycle(DesktopOptions{
		Bridge: bridge, Lifecycle: power,
		Binding: func() string { return identity }, Configured: func() bool { return true },
	})
	defer desktop.Close()
	power.afterSuspend = func() { identity = "replacement-owner" }
	if result, err := desktop.Exit(t.Context()); !errors.Is(err, ErrDesktopBusy) || result.OK || bridge.disconnected != 0 || power.suspended != 1 || desktop.Phase() != contracts.DesktopPhaseIdle {
		t.Fatal("late suspension result disconnected a different VM or invented a confirmed exit", err)
	}
}
