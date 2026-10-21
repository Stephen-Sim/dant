package controller

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestOrdinaryOfflineExitConfirmsAnAlreadyInactiveOwnerWithoutGuestOrPowerActions(t *testing.T) {
	for _, state := range []contracts.VmPowerState{contracts.VmPowerStateSuspended, contracts.VmPowerStateOff} {
		t.Run(string(state), func(t *testing.T) {
			bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOffline}
			power := &desktopPowerFixture{
				inspect: func(context.Context) (computer.InspectResult, error) {
					return computer.InspectResult{OK: true, Supported: true, State: state}, nil
				},
			}
			desktop := NewDesktopLifecycle(DesktopOptions{
				Bridge:     bridge,
				Lifecycle:  power,
				Configured: func() bool { return true },
				Binding:    func() string { return "same-owner" },
			})

			result, err := desktop.Exit(t.Context())
			if err != nil || !result.OK || result.WorkPaused ||
				!result.VMAlreadyInactive || result.VMState != state ||
				result.VMSuspended == nil || !*result.VMSuspended || result.Unsupported {
				t.Fatal("an inactive VM was not confirmed truthfully", result, err)
			}
			if bridge.connected != 0 || bridge.paused != 0 || bridge.disconnected != 1 ||
				power.inspected != 1 || power.suspended != 0 || power.resumed != 0 ||
				desktop.Phase() != contracts.DesktopPhaseSuspended {
				t.Fatal("an already inactive VM was connected, paused or power managed")
			}
			raw, _ := json.Marshal(result)
			var wire map[string]json.RawMessage
			if json.Unmarshal(raw, &wire) != nil || wire["workPaused"] != nil ||
				string(wire["vmAlreadyInactive"]) != "true" || string(wire["vmSuspended"]) != "true" {
				t.Fatal("inactive Exit invented guest pause proof")
			}
		})
	}
}

func TestOfflineExitBlocksMutatingRoutesDuringInspection(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	app.desktop.Close()
	bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOffline}
	power := &desktopPowerFixture{
		inspect: func(context.Context) (computer.InspectResult, error) {
			if !app.desktop.Blocked() || app.desktop.Phase() != contracts.DesktopPhasePausing {
				t.Fatal("offline inspection did not block new work before observing the VM")
			}
			settings := controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"theme":"light"}`)
			assertControllerCode(t, settings, 409, "desktop_transition_busy")
			connect := controllerRecordedRequest(t, app, token, "POST", "/api/connect", `{}`)
			assertControllerCode(t, connect, 409, "desktop_transition_busy")
			if response := controllerRecordedRequest(t, app, token, "GET", "/api/state", ""); response.Code != 200 {
				t.Fatal("inspection blocked a read-only state request", response.Code)
			}
			return computer.InspectResult{OK: true, Supported: true, State: contracts.VmPowerStateOff}, nil
		},
	}
	app.desktop = NewDesktopLifecycle(DesktopOptions{
		Bridge:     bridge,
		Lifecycle:  power,
		Configured: func() bool { return true },
		Binding:    func() string { return "same-owner" },
	})

	response := controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", `{}`)
	if response.Code != 200 || power.inspected != 1 ||
		bridge.connected != 0 || bridge.paused != 0 || power.suspended != 0 {
		t.Fatal("inspection admission allowed a guest or power side effect", response.Code)
	}
}

func TestOfflineExitRejectsRetiredAdmissionBeforeInspection(t *testing.T) {
	for _, failure := range []string{"binding", "cancelled", "closed"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			identity := "original"
			bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOffline}
			power := &desktopPowerFixture{}
			var desktop *DesktopLifecycle
			desktop = NewDesktopLifecycle(DesktopOptions{
				Bridge:     bridge,
				Lifecycle:  power,
				Configured: func() bool { return true },
				Binding:    func() string { return identity },
				Changed: func() {
					if desktop.Phase() != contracts.DesktopPhasePausing {
						return
					}
					switch failure {
					case "binding":
						identity = "replacement"
					case "cancelled":
						cancel()
					case "closed":
						desktop.Close()
					}
				},
			})

			result, err := desktop.Exit(ctx)
			if err == nil || result.OK || power.inspected != 0 ||
				bridge.connected != 0 || bridge.paused != 0 || bridge.disconnected != 0 ||
				power.suspended != 0 {
				t.Fatal("retired admission reached VM inspection or changed the guest", result, err)
			}
		})
	}
}

func TestOfflineRunningExitInspectsThenConnectsPausesAndSuspendsOnce(t *testing.T) {
	order := []string{}
	base := &desktopBridgeFixture{
		status: contracts.ConnectionStatusOffline,
		state:  controllerQuiescentState(contracts.ConnectionStatusOnline),
		pause:  func() { order = append(order, "pause") },
	}
	bridge := &controllerDesktopBridge{
		desktopBridgeFixture: base,
		connect: func(ctx context.Context, deploy bool) error {
			order = append(order, "connect")
			return base.Connect(ctx, deploy)
		},
	}
	power := &retiringDesktopPower{
		desktopPowerFixture: &desktopPowerFixture{
			supported: true,
			inspect: func(context.Context) (computer.InspectResult, error) {
				order = append(order, "inspect")
				return computer.InspectResult{OK: true, Supported: true, State: contracts.VmPowerStateRunning}, nil
			},
		},
		afterSuspend: func() { order = append(order, "suspend") },
	}
	desktop := NewDesktopLifecycle(DesktopOptions{
		Bridge:     bridge,
		Lifecycle:  power,
		Configured: func() bool { return true },
		Binding:    func() string { return "same" },
	})

	result, err := desktop.Exit(t.Context())
	if err != nil || !result.OK || !result.WorkPaused || result.VMAlreadyInactive ||
		power.suspended != 1 || power.resumed != 0 ||
		!reflect.DeepEqual(order, []string{"inspect", "connect", "pause", "suspend"}) {
		t.Fatal("running VM Exit lost pause-before-suspend ordering", result, order, err)
	}
}

func TestInstallExitAlwaysRequiresGuestPauseEvenWhenTheManagedVMIsInactive(t *testing.T) {
	bridge := &controllerDesktopBridge{
		desktopBridgeFixture: &desktopBridgeFixture{status: contracts.ConnectionStatusOffline},
		connect: func(context.Context, bool) error {
			return errors.New("isolated guest unavailable")
		},
	}
	power := &desktopPowerFixture{
		inspect: func(context.Context) (computer.InspectResult, error) {
			t.Fatal("installation used ordinary Exit's inactive shortcut")
			return computer.InspectResult{OK: true, Supported: true, State: contracts.VmPowerStateSuspended}, nil
		},
	}
	desktop := NewDesktopLifecycle(DesktopOptions{
		Bridge:     bridge,
		Lifecycle:  power,
		Configured: func() bool { return true },
		Binding:    func() string { return "same" },
	})

	result, err := desktop.ExitForInstall(t.Context())
	if err == nil || result.OK || result.WorkPaused || result.VMAlreadyInactive ||
		power.inspected != 0 || power.suspended != 0 || bridge.disconnected != 0 {
		t.Fatal("installation accepted physical inactivity without guest preparation", result, err)
	}
}

func TestInstallExitRouteRetainsStrictGuestPreparationAndReleasesAFailedLease(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	leaseID := controllerFixtureInstallLease(t, app)
	app.desktop.Close()
	bridge := &controllerDesktopBridge{
		desktopBridgeFixture: &desktopBridgeFixture{status: contracts.ConnectionStatusOffline},
		connect: func(context.Context, bool) error {
			return computer.ErrPauseUnconfirmed
		},
	}
	power := &desktopPowerFixture{
		inspect: func(context.Context) (computer.InspectResult, error) {
			t.Fatal("installation route used the ordinary Exit observation shortcut")
			return computer.InspectResult{}, nil
		},
	}
	app.desktop = NewDesktopLifecycle(DesktopOptions{
		Bridge:     bridge,
		Lifecycle:  power,
		Configured: func() bool { return true },
		Binding:    func() string { return "same" },
	})

	response := controllerRecordedRequest(t, app, token, "POST", "/api/desktop/exit", `{"reason":"install","leaseId":"`+leaseID+`"}`)
	if response.Code != 409 || app.lease.Current() != nil ||
		power.inspected != 0 || power.suspended != 0 || bridge.disconnected != 0 {
		t.Fatal("installation accepted inactivity or retained a failed installation lease", response.Code)
	}
}

func TestOfflineExitRefusesUnknownPermissionAndRetiredObservationsWithoutGuestSideEffects(t *testing.T) {
	for _, failure := range []string{"unknown", "permission", "binding", "cancelled", "not-ok"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			identity := "original"
			bridge := &desktopBridgeFixture{status: contracts.ConnectionStatusOffline}
			power := &desktopPowerFixture{
				inspect: func(context.Context) (computer.InspectResult, error) {
					result := computer.InspectResult{OK: true, Supported: true, State: contracts.VmPowerStateOff}
					switch failure {
					case "unknown":
						result.State = contracts.VmPowerState("unknown")
					case "permission":
						return computer.InspectResult{}, &computer.LifecycleError{Reason: computer.LifecycleReasonUnconfirmed}
					case "binding":
						identity = "replacement"
					case "cancelled":
						cancel()
					case "not-ok":
						result.OK = false
					}
					return result, nil
				},
			}
			desktop := NewDesktopLifecycle(DesktopOptions{
				Bridge:     bridge,
				Lifecycle:  power,
				Configured: func() bool { return true },
				Binding:    func() string { return identity },
			})

			result, err := desktop.Exit(ctx)
			if err == nil || result.OK || result.WorkPaused || result.VMAlreadyInactive ||
				bridge.connected != 0 || bridge.paused != 0 || bridge.disconnected != 0 ||
				power.suspended != 0 || power.resumed != 0 || desktop.Phase() != contracts.DesktopPhaseIdle {
				t.Fatal("unconfirmed physical state caused a guest or power action", result, err)
			}
		})
	}
}
