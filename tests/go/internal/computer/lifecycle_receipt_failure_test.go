package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func commandResultChanged(t *testing.T, state string, changed bool) []byte {
	t.Helper()
	var result lifecycleCommandResult
	if err := json.Unmarshal(commandResult(state, nil), &result); err != nil {
		t.Fatal(err)
	}
	result.Changed = &changed
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestRepeatedSuspendAndAlreadySuspendedObservationKeepOnlyTheirOwnedReceipt(t *testing.T) {
	for _, retained := range []bool{false, true} {
		t.Run(map[bool]string{false: "already suspended independently", true: "previous owned suspend"}[retained], func(t *testing.T) {
			calls := 0
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				return commandResultChanged(t, "suspended", retained && calls == 1), nil
			})
			count := 1
			if retained {
				count = 2
			}
			for range count {
				result, err := lifecycle.Suspend(t.Context())
				if err != nil || !result.OK || !result.Supported || !result.VMSuspended {
					t.Fatal("independently observed suspended VM was not classified correctly", err)
				}
			}
			receipt, err := lifecycle.receipt()
			if err != nil || calls != count || retained && (receipt == nil || receipt.Phase != contracts.VmReceiptPhaseSuspended) || !retained && receipt != nil {
				t.Fatal("suspend adopted an unowned power change or discarded its original receipt", err)
			}
			if _, err := os.Stat(filepath.Join(directory, "vm", "dant.vhdx")); err != nil {
				t.Fatal("power observation removed the owned disk", err)
			}
		})
	}
}

func TestChangedBindingCannotReuseAPreviousSuspendOrResumeReceipt(t *testing.T) {
	for _, action := range []string{"suspend", "resume"} {
		t.Run(action, func(t *testing.T) {
			calls := 0
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				return commandResult("suspended", nil), nil
			})
			if _, err := lifecycle.Suspend(t.Context()); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(lifecycle.file)
			if err != nil {
				t.Fatal(err)
			}
			binding, err := ReadBinding(directory)
			if err != nil {
				t.Fatal(err)
			}
			binding.Host = "192.0.2.77"
			raw, err := json.Marshal(binding)
			if err != nil || os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600) != nil {
				t.Fatal("fixture could not replace its connection identity", err)
			}
			if action == "suspend" {
				_, err = lifecycle.Suspend(t.Context())
			} else {
				_, err = lifecycle.Resume(t.Context())
			}
			var failure *LifecycleError
			current, readErr := os.ReadFile(lifecycle.file)
			if !errors.As(err, &failure) || failure.Reason != LifecycleReasonBindingChanged || readErr != nil || string(current) != string(before) || calls != 1 {
				t.Fatal("replacement binding inherited or revoked another connection's power receipt", err)
			}
		})
	}
}

func TestResumeRequiresAConfirmedRunningOrOffStateAndRetainsUnknownPowerIntent(t *testing.T) {
	for _, scenario := range []string{"transport failure", "still suspended"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				if calls == 2 && scenario == "transport failure" {
					return nil, io.ErrUnexpectedEOF
				}
				return commandResult("suspended", nil), nil
			})
			if _, err := lifecycle.Suspend(t.Context()); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filepath.Join(directory, "vm.json"))
			if err != nil {
				t.Fatal(err)
			}
			_, err = lifecycle.Resume(t.Context())
			var failure *LifecycleError
			if !errors.As(err, &failure) || failure.Reason != LifecycleReasonUnconfirmed || calls != 2 {
				t.Fatal("unconfirmed resume was accepted or repeated", err)
			}
			receipt, err := lifecycle.receipt()
			current, readErr := os.ReadFile(filepath.Join(directory, "vm.json"))
			if err != nil || receipt == nil || receipt.Phase != contracts.VmReceiptPhaseResuming || readErr != nil || string(current) != string(before) {
				t.Fatal("unconfirmed power result lost its intent or rewrote the connection address", err)
			}
		})
	}
}
