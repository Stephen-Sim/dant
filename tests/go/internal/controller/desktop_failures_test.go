package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
)

func TestDesktopFailuresKeepTheirPhaseCodeAndQuiescenceGuards(t *testing.T) {
	private := "synthetic-private-token private-account private-host.invalid 192.0.2.44"
	for _, test := range []struct {
		name       string
		pauseError error
		powerError error
		code       string
		phase      contracts.DesktopPhase
		status     int
		powerCalls int
	}{
		{
			name:       "pause unconfirmed",
			pauseError: fmt.Errorf("%s: %w", private, computer.ErrPauseUnconfirmed),
			code:       codePauseUnconfirmed, phase: contracts.DesktopPhasePausing,
			status: 409,
		},
		{
			name:       "suspension unconfirmed",
			powerError: fmt.Errorf("%s: %w", private, &computer.LifecycleError{Reason: computer.LifecycleReasonUnconfirmed}),
			code:       "vm_lifecycle_unconfirmed", phase: contracts.DesktopPhaseSuspending,
			status: 409, powerCalls: 1,
		},
		{
			name:       "binding changed",
			powerError: &computer.LifecycleError{Reason: computer.LifecycleReasonBindingChanged},
			code:       "vm_lifecycle_binding_changed", phase: contracts.DesktopPhaseSuspending,
			status: 409, powerCalls: 1,
		},
		{
			name:       "unknown lifecycle reason is never reflected",
			powerError: &computer.LifecycleError{Reason: computer.LifecycleReason(private)},
			code:       "vm_lifecycle_unconfirmed", phase: contracts.DesktopPhaseSuspending,
			status: 409, powerCalls: 1,
		},
		{
			name:       "private failure remains bounded",
			pauseError: errors.New(private),
			code:       codeRequestFailed, phase: contracts.DesktopPhasePausing,
			status: 502,
		},
		{
			name:       "pause deadline remains unconfirmed",
			pauseError: fmt.Errorf("%s: %w", private, context.DeadlineExceeded),
			code:       codeRequestTimeout, phase: contracts.DesktopPhasePausing,
			status: 504,
		},
		{
			name:       "suspension cancellation remains unconfirmed",
			powerError: fmt.Errorf("%s: %w", private, context.Canceled),
			code:       codeRequestCancelled, phase: contracts.DesktopPhaseSuspending,
			status: 499, powerCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			logger, err := diagnostics.New(t.Context(), diagnostics.Options{DataDir: directory, Role: "controller"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = logger.Close() })
			bridge := &desktopBridgeFixture{
				status:   contracts.ConnectionStatusOnline,
				state:    contracts.WorkerSnapshot{Worker: contracts.WorkerState{Status: contracts.ConnectionStatusOnline}},
				pauseErr: test.pauseError,
			}
			power := &desktopPowerFixture{supported: true, err: test.powerError}
			desktop := NewDesktopLifecycle(DesktopOptions{
				Bridge: bridge, Lifecycle: power,
				Binding:     func() string { return "fixed-owner" },
				Configured:  func() bool { return true },
				Diagnostics: logger,
			})
			defer desktop.Close()
			result, err := desktop.Exit(context.Background())
			if err == nil || result.OK || bridge.paused != 1 || power.suspended != test.powerCalls || bridge.disconnected != 0 {
				t.Fatal("failure was accepted, replayed or crossed the pause/power boundary")
			}
			if test.pauseError != nil && !errors.Is(err, test.pauseError) {
				t.Fatal("phase annotation lost the classified cause")
			}
			if desktop.Phase() != contracts.DesktopPhaseIdle {
				t.Fatal("failed transition did not release its local reservation")
			}

			recorder := httptest.NewRecorder()
			writeError(recorder, err)
			var body errorBody
			if json.Unmarshal(recorder.Body.Bytes(), &body) != nil || recorder.Code != test.status || body.Code != test.code || body.Phase != test.phase || strings.Contains(recorder.Body.String(), private) {
				t.Fatal("HTTP failure lost its safe stage/code contract")
			}

			if err := logger.Close(); err != nil {
				t.Fatal(err)
			}
			records, err := logger.Recent(context.Background(), 20)
			if err != nil || len(records) < 2 {
				t.Fatal("transition diagnostics were not durably recorded", err)
			}
			last := records[len(records)-1]
			if last.Event != "desktop.exit.failed" || last.Route != desktopExitRoute || last.Code != test.code || last.Phase != string(test.phase) {
				t.Fatal("reset-to-idle hid the actual failure stage")
			}
			for _, record := range records {
				if record.Event == "desktop.exit.confirmed" {
					t.Fatal("failed exit was recorded as confirmed")
				}
			}
			entries, err := os.ReadDir(logger.Status().Directory)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				raw, err := os.ReadFile(filepath.Join(logger.Status().Directory, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				for _, secret := range strings.Fields(private) {
					if strings.Contains(string(raw), secret) {
						t.Fatal("diagnostics persisted private error content")
					}
				}
			}
		})
	}
}

func TestDesktopHTTPPreconditionFailureRetainsItsFixedRouteWithoutStartingWork(t *testing.T) {
	app, bridge, server, token := controllerAppFixture(t)
	app.lease.Close()
	response := controllerRequest(t, server, token, "POST", desktopExitRoute, `{}`)
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	var body errorBody
	if err != nil || json.Unmarshal(raw, &body) != nil || response.StatusCode != 409 || body.Code != codeDesktopBusy || body.Phase != "" {
		t.Fatal("precondition failure invented a running transition or lost its code")
	}
	if bridge.pauses != 0 || bridge.connects != 0 || app.desktop.Phase() != contracts.DesktopPhaseIdle {
		t.Fatal("rejected exit started work or a VM transition")
	}
	if err := app.diagnostics.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := app.diagnostics.Recent(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		if record.Event == "desktop.request.failed" {
			found = record.Route == desktopExitRoute && record.Code == codeDesktopBusy && record.Phase == ""
		}
	}
	if !found {
		t.Fatal("HTTP rejection was reduced to an unknown route")
	}
}

func TestLifecycleHTTPReasonCodesStayFixedAcrossWrappedErrors(t *testing.T) {
	for _, reason := range []computer.LifecycleReason{
		computer.LifecycleReasonBusy, computer.LifecycleReasonInvalidIdentity,
		computer.LifecycleReasonInvalidReceipt, computer.LifecycleReasonBindingChanged,
		computer.LifecycleReasonIntentChanged, computer.LifecycleReasonUnconfirmed,
		computer.LifecycleReasonUnsupported,
	} {
		err := &computer.LifecycleError{Reason: reason}
		recorder := httptest.NewRecorder()
		writeError(recorder, fmt.Errorf("private wrapper: %w", err))
		var body errorBody
		if json.Unmarshal(recorder.Body.Bytes(), &body) != nil || recorder.Code != 409 || body.Code != err.Code() || strings.Contains(body.Error, "private wrapper") {
			t.Fatal("lifecycle failure did not retain its stable safe API category")
		}
	}
}
