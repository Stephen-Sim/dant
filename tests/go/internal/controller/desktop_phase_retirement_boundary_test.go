package controller

import (
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDesktopClosureBetweenAdmissionAndPhaseCommitCannotReportSuccess(t *testing.T) {
	for _, stage := range []string{"pause-entry", "prepare-resume-entry", "suspend-entry", "suspend-completion", "cancel-entry", "cancel-completion"} {
		t.Run(stage, func(t *testing.T) {
			bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOnline)}
			power := &desktopPowerFixture{}
			if stage == "prepare-resume-entry" {
				bridge.status = contracts.ConnectionStatusOffline
			}
			reads := 0
			closeAt := 1
			if stage == "suspend-entry" {
				closeAt = 0
			} else if stage == "suspend-completion" || stage == "cancel-completion" {
				closeAt = 3
			}
			var desktop *DesktopLifecycle
			desktop = NewDesktopLifecycle(DesktopOptions{
				Bridge: bridge, Lifecycle: power,
				Configured: func() bool { return stage == "prepare-resume-entry" },
				Binding: func() string {
					reads++
					if reads == closeAt {
						desktop.Close()
					}
					return "captured-isolated-binding"
				},
				Changed: func() {
					if stage == "suspend-entry" && desktop.Phase() == contracts.DesktopPhasePaused {
						desktop.Close()
					}
				},
			})
			defer desktop.Close()
			var result DesktopResult
			var err error
			if stage == "prepare-resume-entry" {
				result, err = desktop.Prepare(t.Context(), PrepareOptions{})
			} else if stage == "cancel-entry" || stage == "cancel-completion" {
				result, err = desktop.Cancel(t.Context(), false)
			} else {
				result, err = desktop.Exit(t.Context())
			}
			if !errors.Is(err, ErrDesktopBusy) || result.OK || bridge.connected != 0 || bridge.paused != 0 || bridge.disconnected != 0 {
				t.Fatal("retired phase commit invented success or crossed a connection boundary", err)
			}
			wantSuspends, wantResumes := 0, 0
			if stage == "suspend-completion" {
				wantSuspends = 1
			} else if stage == "cancel-completion" {
				wantResumes = 1
			}
			if power.suspended != wantSuspends || power.resumed != wantResumes {
				t.Fatal("retired phase commit advanced or replayed a power operation")
			}
		})
	}
}

func TestDesktopAlreadyStoppedWorkerNeedsFreshProofWithoutAPauseRequest(t *testing.T) {
	bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOffline)}
	power := &desktopPowerFixture{}
	desktop := NewDesktopLifecycle(DesktopOptions{
		Bridge: bridge, Lifecycle: power,
		Binding: func() string { return "captured-isolated-binding" }, Configured: func() bool { return true },
	})
	defer desktop.Close()
	result, err := desktop.Prepare(t.Context(), PrepareOptions{})
	if err != nil || !result.OK || !result.WorkPaused || desktop.Phase() != contracts.DesktopPhasePaused || bridge.paused != 0 || bridge.connected != 0 || power.resumed != 0 || power.suspended != 0 {
		t.Fatal("already stopped Worker did not use its refreshed quiescence proof", err)
	}
}
