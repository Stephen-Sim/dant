package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controllerOperationBridge struct {
	*controllerBridgeFixture
	connectOperation func(context.Context, bool) error
	refreshOperation func(context.Context) (contracts.WorkerSnapshot, error)
	prepareOperation func(context.Context) error
}

func (bridge *controllerOperationBridge) Connect(ctx context.Context, deploy bool) error {
	if bridge.connectOperation != nil {
		return bridge.connectOperation(ctx, deploy)
	}
	return bridge.controllerBridgeFixture.Connect(ctx, deploy)
}

func (bridge *controllerOperationBridge) Refresh(ctx context.Context) (contracts.WorkerSnapshot, error) {
	if bridge.refreshOperation != nil {
		return bridge.refreshOperation(ctx)
	}
	return bridge.controllerBridgeFixture.Refresh(ctx)
}

func (bridge *controllerOperationBridge) Prepare(ctx context.Context) error {
	if bridge.prepareOperation != nil {
		return bridge.prepareOperation(ctx)
	}
	return nil
}

func controllerOperationsFixture(t *testing.T) (*App, *controllerOperationBridge, *desktopPowerFixture, string) {
	t.Helper()
	app, existing, _, token := controllerAppFixture(t)
	bridge := &controllerOperationBridge{controllerBridgeFixture: existing}
	power := &desktopPowerFixture{}
	app.bridge = bridge
	app.lifecycle = power
	app.desktop.Close()
	app.desktop = NewDesktopLifecycle(DesktopOptions{
		Bridge: bridge, Lifecycle: power,
		Binding: app.bindingIdentity, Configured: func() bool { return false },
		Changed: app.broadcastState,
	})
	return app, bridge, power, token
}

func controllerQuiescentState(status contracts.ConnectionStatus) contracts.WorkerSnapshot {
	state := emptyWorkerSnapshot()
	state.Worker.Status = status
	state.Extra["computer"] = json.RawMessage(`{"status":"dant","sessionId":null,"pending":false,"acquiring":false}`)
	return state
}

func TestControllerManualReconnectRecoversOnlyConfirmedIdleExecutor(t *testing.T) {
	for _, fixture := range []struct {
		name           string
		busy           bool
		workerResponse int
		finalOnline    bool
		wantStatus     int
		wantRecoveries int
	}{
		{"confirmed idle", false, 200, true, 200, 1},
		{"unfinished work", true, 200, true, 409, 0},
		{"worker rejected", false, 409, true, 502, 1},
		{"worker still stopped", false, 200, false, 502, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			app, bridge, power, token := controllerOperationsFixture(t)
			bridge.mu.Lock()
			bridge.state = controllerQuiescentState(contracts.ConnectionStatusOffline)
			if fixture.busy {
				bridge.state.Queue = []string{"unfinished-message"}
			}
			bridge.mu.Unlock()
			recoveries := 0
			bridge.request = func(_ context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
				raw, _ := io.ReadAll(body)
				if method != "POST" || route != "/api/connect" || string(raw) != `{"idleRecovery":true}` || headers.Get("Content-Type") != "application/json" {
					t.Error("reconnect changed the explicit idle-recovery contract")
				}
				recoveries++
				if fixture.finalOnline {
					bridge.mu.Lock()
					bridge.state.Worker.Status = contracts.ConnectionStatusOnline
					bridge.mu.Unlock()
				}
				return &http.Response{StatusCode: fixture.workerResponse, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			}
			response := controllerRecordedRequest(t, app, token, "POST", "/api/connect", `{}`)
			if response.Code != fixture.wantStatus || recoveries != fixture.wantRecoveries || power.resumed != 1 || bridge.connects != 1 || app.desktop.Phase() != contracts.DesktopPhaseIdle {
				t.Fatalf("reconnect crossed a stop-proof boundary: status=%d recoveries=%d resumes=%d connects=%d", response.Code, recoveries, power.resumed, bridge.connects)
			}
			app.mu.Lock()
			pending, manual := app.connectionPending, app.manual
			app.mu.Unlock()
			if pending || manual {
				t.Fatal("reconnect outcome left admission permanently reserved")
			}
		})
	}
}

func TestControllerPrepareAndConnectionFailuresReleaseReservationsWithoutReplay(t *testing.T) {
	app, bridge, power, token := controllerOperationsFixture(t)
	prepares := 0
	bridge.prepareOperation = func(context.Context) error {
		prepares++
		return context.DeadlineExceeded
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/prepare", `{}`), 504, "request_timeout")
	if prepares != 1 || power.resumed != 0 || bridge.connects != 0 {
		t.Fatal("preparation failure connected or replayed a worker operation")
	}
	bridge.connectOperation = func(context.Context, bool) error { return computer.ErrBridgeOffline }
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "POST", "/api/service-update", `{"action":"install"}`), 503, "vm_offline")
	if app.connectionPending || app.manual || app.desktop.Blocked() {
		t.Fatal("failed explicit installation left a desktop or connection reservation")
	}

	app.connectMu.Lock()
	if err := app.prepareConnection(context.Background()); !errors.Is(err, computer.ErrBridgeBusy) {
		t.Fatal("concurrent preparation was admitted")
	}
	if err := app.connect(context.Background(), false, false); !errors.Is(err, computer.ErrBridgeBusy) {
		t.Fatal("concurrent connection was admitted")
	}
	app.connectMu.Unlock()
	app.lease.Close()
	if err := app.prepareConnection(context.Background()); err == nil {
		t.Fatal("closed install admission accepted preparation")
	}
}

func TestControllerOnlineConnectionDoesNotRestartExecutorOrPower(t *testing.T) {
	app, bridge, power, _ := controllerOperationsFixture(t)
	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.state = controllerQuiescentState(contracts.ConnectionStatusOnline)
	bridge.mu.Unlock()
	if err := app.connect(context.Background(), false, false); err != nil {
		t.Fatal(err)
	}
	if bridge.connects != 1 || power.resumed != 0 || power.suspended != 0 {
		t.Fatal("ordinary connection performed executor recovery or VM power actions")
	}
	if err := app.connect(context.Background(), true, false); err != nil || power.resumed != 0 {
		t.Fatal("online reconnect unnecessarily resumed the VM")
	}
}

func TestControllerPreferenceSyncPreservesCapturedBindingAndGeneration(t *testing.T) {
	for _, fixture := range []struct {
		name         string
		response     int
		retire       bool
		requestError error
		refreshError error
		want         error
	}{
		{"accepted", 200, false, nil, nil, nil},
		{"generation retired", 200, true, nil, nil, computer.ErrBridgeChanged},
		{"worker rejected", 403, false, nil, nil, computer.ErrSessionUnavailable},
		{"transport lost", 0, false, computer.ErrBridgeOffline, nil, computer.ErrBridgeOffline},
		{"refresh lost", 200, false, nil, context.Canceled, context.Canceled},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			app, bridge, _, _ := controllerOperationsFixture(t)
			app.options.TimeZone = "Asia/Kuala_Lumpur"
			app.configuration.Language = "en"
			bridge.mu.Lock()
			bridge.status = contracts.ConnectionStatusOnline
			bridge.state.Extra["capabilities"] = json.RawMessage(`{"languages":["en","zh"]}`)
			bridge.mu.Unlock()
			requests := 0
			bridge.request = func(_ context.Context, method, route string, _ http.Header, body io.Reader) (*http.Response, error) {
				requests++
				var preference struct {
					Language string
					TimeZone string
				}
				if json.NewDecoder(body).Decode(&preference) != nil || preference.Language != "en" || preference.TimeZone != app.options.TimeZone || method != "PATCH" || route != "/api/settings" {
					t.Error("preference synchronization changed language or canonical timezone")
				}
				if fixture.retire {
					bridge.Disconnect()
				}
				if fixture.requestError != nil {
					return nil, fixture.requestError
				}
				return &http.Response{StatusCode: fixture.response, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			}
			if fixture.refreshError != nil {
				bridge.refreshOperation = func(context.Context) (contracts.WorkerSnapshot, error) {
					return contracts.WorkerSnapshot{}, fixture.refreshError
				}
			}
			if err := app.syncPreferences(context.Background()); !errors.Is(err, fixture.want) || requests != 1 {
				t.Fatal("preference sync accepted an unconfirmed owner or lost the classified failure")
			}
		})
	}
}

func TestControllerBackgroundAdmissionAndStartRespectExplicitPauseAndShutdown(t *testing.T) {
	app, bridge, _, _ := controllerOperationsFixture(t)
	app.Start()
	if app.started || app.backgroundAllowed() {
		t.Fatal("prepare-only constructor enabled background connections")
	}
	app.options.PrepareOnly = false
	app.mu.Lock()
	app.started = true
	app.mu.Unlock()
	if !app.backgroundAllowed() {
		t.Fatal("idle, explicitly started host rejected background maintenance")
	}
	for _, flag := range []*bool{&app.manual, &app.connectionPending} {
		app.mu.Lock()
		*flag = true
		app.mu.Unlock()
		if app.backgroundAllowed() {
			t.Fatal("background maintenance raced an explicit connection")
		}
		app.mu.Lock()
		*flag = false
		app.mu.Unlock()
	}
	if err := app.desktop.SetPhase(contracts.DesktopPhasePaused); err != nil {
		t.Fatal(err)
	}
	if app.backgroundAllowed() {
		t.Fatal("background maintenance ignored an explicit desktop pause")
	}
	app.releasePrepared()
	if app.desktop.Phase() != contracts.DesktopPhaseIdle {
		t.Fatal("releasing prepared installation did not clear its local pause")
	}
	app.mu.Lock()
	app.started = false
	app.configuration.ServiceUpdatesPaused = true
	app.mu.Unlock()
	app.Start()
	app.Start()
	app.Close()
	if app.backgroundAllowed() || bridge.connects != 0 {
		t.Fatal("shutdown or paused monitoring started worker work")
	}
	app.Start()
	app.Close()
}
