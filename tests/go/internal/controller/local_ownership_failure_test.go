package controller

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

func controllerFixtureInstallLease(t *testing.T, app *App) string {
	t.Helper()
	app.lease.Close()
	app.lease = updates.NewInstallLease(updates.LeaseOptions{
		Snapshot: func() updates.InstallationSnapshot {
			return updates.InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusIdle, Worker: emptyWorkerSnapshot()}
		},
		Refresh: func(context.Context) error { return nil },
	})
	receipt, err := app.lease.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return receipt.LeaseID
}

func TestControllerDesktopRoutesRetainExactInstallationLeaseOwnership(t *testing.T) {
	for _, mode := range []string{"exit-mismatched-owner", "cancel-mismatched-owner", "cancel-foreign-owner", "exit-failed", "exit-renew-unconfirmed", "cancel-release-unconfirmed"} {
		t.Run(mode, func(t *testing.T) {
			app, bridge, _, _ := controllerAppFixture(t)
			leaseID := controllerFixtureInstallLease(t, app)
			app.desktop.Close()
			desktopBridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOnline, state: controllerQuiescentState(contracts.ConnectionStatusOnline)}
			power := &retiringDesktopPower{desktopPowerFixture: &desktopPowerFixture{supported: true}, afterSuspend: func() {}}
			var lifecycle OwnedVMLifecycle = power
			if mode == "exit-failed" {
				desktopBridge.pauseErr = computer.ErrPauseUnconfirmed
			}
			if mode == "exit-renew-unconfirmed" {
				power.afterSuspend = func() {
					if err := app.lease.Release(leaseID); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "cancel-release-unconfirmed" {
				bridge.status = contracts.ConnectionStatusOnline
				lifecycle = &controllerDesktopPower{
					desktopPowerFixture: &desktopPowerFixture{},
					resume: func(context.Context) (computer.ResumeResult, error) {
						if err := app.lease.Release(leaseID); err != nil {
							t.Fatal(err)
						}
						return computer.ResumeResult{OK: true}, nil
					},
				}
			}
			app.lifecycle = lifecycle
			app.desktop = NewDesktopLifecycle(DesktopOptions{
				Bridge: desktopBridge, Lifecycle: lifecycle,
				Binding: func() string { return "captured" }, Configured: func() bool { return true },
			})
			path := "/api/desktop/exit"
			body := `{"reason":"install","leaseId":"` + leaseID + `"}`
			switch mode {
			case "exit-mismatched-owner":
				body = `{"leaseId":"` + leaseID + `"}`
			case "cancel-mismatched-owner":
				path = "/api/desktop/cancel-exit"
				body = `{"reason":"install","leaseId":"different-owner"}`
			case "cancel-foreign-owner":
				if err := app.lease.Release(leaseID); err != nil {
					t.Fatal(err)
				}
				path = "/api/desktop/cancel-exit"
			case "cancel-release-unconfirmed":
				path = "/api/desktop/cancel-exit"
			}
			err := app.desktopRoute(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
			if err == nil {
				t.Fatal("unconfirmed desktop lease operation returned success")
			}
			if mode == "exit-failed" && !errors.Is(err, computer.ErrPauseUnconfirmed) {
				t.Fatal("desktop exit lost the actual pause failure", err)
			}
			if mode == "exit-failed" || mode == "exit-renew-unconfirmed" || mode == "cancel-release-unconfirmed" {
				if app.lease.Current() != nil {
					t.Fatal("failed or independently released transition retained an installation lease")
				}
			} else if power.suspended != 0 || power.resumed != 0 || desktopBridge.paused != 0 {
				t.Fatal("wrong lease owner triggered a VM transition")
			}
		})
	}
}

func TestControllerDesktopOpenAndCancelFailuresPreserveTheBlockedTransition(t *testing.T) {
	for _, path := range []string{"/api/desktop/open", "/api/desktop/cancel-exit"} {
		t.Run(path, func(t *testing.T) {
			app, bridge, _, _ := controllerAppFixture(t)
			power := &desktopPowerFixture{}
			app.lifecycle = power
			if err := app.desktop.SetPhase(contracts.DesktopPhasePaused); err != nil {
				t.Fatal(err)
			}
			app.desktop.Close()
			if err := app.desktopRoute(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))); !errors.Is(err, ErrDesktopBusy) {
				t.Fatal("closed desktop transition was implicitly reopened", err)
			}
			if bridge.connects != 0 || bridge.pauses != 0 || !app.desktop.Blocked() {
				t.Fatal("failed open/cancel advanced the worker or hid the blocked phase")
			}
		})
	}
}
