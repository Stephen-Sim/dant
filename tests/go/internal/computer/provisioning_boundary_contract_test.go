package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

func provisioningContractOptions(t *testing.T) ProvisioningOptions {
	t.Helper()
	root := t.TempDir()
	host := windowsComputerHost(t, nil)
	return ProvisioningOptions{
		Context: t.Context(), ProjectRoot: root, DataDir: filepath.Join(root, "data"), Host: host,
		Providers: NewProviders(host, ProviderDetection{
			FileExists:   func(string) bool { return true },
			ReadRegistry: func(context.Context, string) (string, error) { return "", ErrProviderUnavailable },
		}),
		Run: func(context.Context, string, []string, io.Reader) ([]byte, error) {
			t.Error("unexpected provisioning process")
			return nil, ErrProvisioningFailed
		},
		ProbeInterval: time.Millisecond, InstallTimeout: time.Second,
	}
}

func writeProvisioningContractStatus(t *testing.T, options ProvisioningOptions, raw string) {
	t.Helper()
	if err := os.MkdirAll(options.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(options.DataDir, "vm-setup-status.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestProvisioningReconstructsOnlyValidatedDurableProgressWithoutStartingHelpers(t *testing.T) {
	for _, test := range []struct {
		stage string
		want  contracts.ProvisioningStatus
	}{
		{"guest-installing", contracts.ProvisioningStatusInstalling},
		{"awaiting-admin", contracts.ProvisioningStatusAwaitingAdmin},
		{"preparing", contracts.ProvisioningStatusPreparing},
		{"creating-owned-computer", contracts.ProvisioningStatusCreating},
		{"failed:guest-installing", contracts.ProvisioningStatusFailed},
		{"ready", contracts.ProvisioningStatusReady},
	} {
		t.Run(test.stage, func(t *testing.T) {
			options := provisioningContractOptions(t)
			raw, _ := json.Marshal(map[string]any{"stage": test.stage, "provider": contracts.VmProviderIdVMware, "selected": contracts.VmProviderIdVMware, "output": "untrusted secret process output"})
			writeProvisioningContractStatus(t, options, string(raw))
			provisioning, err := NewProvisioning(options)
			if err != nil {
				t.Fatal(err)
			}
			defer provisioning.Close()
			state := provisioning.Snapshot()
			if state.Status != test.want || state.Stage != test.stage || state.Provider == nil || *state.Provider != contracts.VmProviderIdVMware || state.Selected != string(contracts.VmProviderIdVMware) || state.Output != "" || state.Running {
				t.Fatal("persisted progress was ignored, executed, or copied untrusted output")
			}
			if state.Error != nil && strings.Contains(*state.Error, "secret") {
				t.Fatal("public progress included untrusted process output")
			}
		})
	}
	for _, raw := range []string{`{`, `[]`, `{"stage":42}`, `{"stage":"bad\nstatus"}`, `{"stage":"` + strings.Repeat("x", 129) + `"}`} {
		options := provisioningContractOptions(t)
		writeProvisioningContractStatus(t, options, raw)
		provisioning, _ := NewProvisioning(options)
		if state := provisioning.Snapshot(); state.Status != contracts.ProvisioningStatusIdle || state.Stage != "idle" {
			t.Fatal("invalid durable progress invented a running installation")
		}
		provisioning.Close()
	}
}

func TestProvisioningTerminalProgressCannotRegressAndSnapshotsAreDetached(t *testing.T) {
	options := provisioningContractOptions(t)
	writeProvisioningContractStatus(t, options, `{"stage":"failed:creating","provider":"hyperv","selected":"hyperv"}`)
	provisioning, _ := NewProvisioning(options)
	defer provisioning.Close()
	writeProvisioningContractStatus(t, options, `{"stage":"creating"}`)
	if state := provisioning.Snapshot(); state.Status != contracts.ProvisioningStatusFailed || state.Error == nil {
		t.Fatal("an older in-progress record concealed a terminal failure")
	}
	writeProvisioningContractStatus(t, options, `{"stage":"ready"}`)
	state := provisioning.Snapshot()
	if state.Status != contracts.ProvisioningStatusReady || state.Error != nil {
		t.Fatal("independent readiness did not resolve prior progress failure")
	}
	*state.Provider = contracts.VmProviderIdVMware
	writeProvisioningContractStatus(t, options, `{"stage":"failed:new"}`)
	if current := provisioning.Snapshot(); current.Status != contracts.ProvisioningStatusReady || current.Provider == nil || *current.Provider != contracts.VmProviderIdHyperV {
		t.Fatal("stale progress or caller pointer mutation changed confirmed readiness")
	}
}

func TestProvisioningCancelledStartDoesNotLaunchAHelperOrLeaveRunningState(t *testing.T) {
	options := provisioningContractOptions(t)
	provisioning, _ := NewProvisioning(options)
	defer provisioning.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := provisioning.Start(ctx, []byte(`{"provider":"hyperv"}`)); !errors.Is(err, context.Canceled) || provisioning.Snapshot().Running {
		t.Fatal("cancelled progress commit launched installation or retained its running owner", err)
	}
	if _, err := os.Stat(filepath.Join(options.DataDir, "vm-setup-status.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled start created a partial durable progress record", err)
	}
}

func TestProvisioningHelperFailureIsBoundedAndPreservesExistingVMArtifacts(t *testing.T) {
	for _, failAt := range []string{"prepare-vm.ps1", "launch-vm.ps1"} {
		t.Run(failAt, func(t *testing.T) {
			options := provisioningContractOptions(t)
			changed := make(chan struct{}, 16)
			options.Changed = func() {
				select {
				case changed <- struct{}{}:
				default:
				}
			}
			var calls atomic.Int32
			options.Run = func(_ context.Context, _ string, args []string, _ io.Reader) ([]byte, error) {
				calls.Add(1)
				for _, arg := range args {
					if filepath.Base(arg) == failAt {
						return []byte("untrusted private output"), errors.New("private failure")
					}
				}
				return nil, nil
			}
			provisioning, _ := NewProvisioning(options)
			defer provisioning.Close()
			if _, err := provisioning.Start(t.Context(), []byte(`{"provider":"hyperv"}`)); err != nil {
				t.Fatal(err)
			}
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			for {
				state := provisioning.Snapshot()
				if !state.Running {
					if state.Status != contracts.ProvisioningStatusFailed || state.Error == nil || state.Output != "" || strings.Contains(*state.Error, "private") || !strings.HasPrefix(state.Stage, "failed:") {
						t.Fatal("helper failure was not represented by bounded operational state")
					}
					break
				}
				select {
				case <-changed:
				case <-deadline.C:
					t.Fatal("failed helper owner did not join")
				}
			}
			wantCalls := int32(1)
			if failAt == "launch-vm.ps1" {
				wantCalls = 2
			}
			if calls.Load() != wantCalls {
				t.Fatal("failed helper was retried or later stages executed")
			}
			if _, err := os.Stat(filepath.Join(options.DataDir, "vm-setup-status.json")); err != nil {
				t.Fatal("helper failure discarded durable setup evidence", err)
			}
		})
	}
}

func TestProvisioningResumeMonitoringDoesNotRepeatCreationAndCloseJoinsItsOwner(t *testing.T) {
	for _, stage := range []string{"awaiting-admin", "guest-installing", "creating"} {
		options := provisioningContractOptions(t)
		writeProvisioningContractStatus(t, options, `{"stage":"`+stage+`","provider":"vmware","selected":"vmware"}`)
		var commands atomic.Int32
		options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
			commands.Add(1)
			return nil, nil
		}
		provisioning, _ := NewProvisioning(options)
		if state := provisioning.ResumeMonitoring(); !state.Running {
			t.Fatal("eligible durable installation could not be monitored")
		}
		provisioning.Close()
		if state := provisioning.Snapshot(); state.Running || state.Status == contracts.ProvisioningStatusFailed || commands.Load() != 0 {
			t.Fatal("monitoring repeated creation, retained its owner, or rewrote progress on close")
		}
		if state := provisioning.ResumeMonitoring(); state.Running {
			t.Fatal("closed provisioning restarted its monitor")
		}
	}
}

func TestProvisioningInvalidRequestsAndUnavailableHostsNeverLaunchCommands(t *testing.T) {
	options := provisioningContractOptions(t)
	for _, invalid := range []ProvisioningOptions{
		{ProjectRoot: options.ProjectRoot, DataDir: options.DataDir},
		{Context: t.Context(), ProjectRoot: "relative", DataDir: options.DataDir},
		{Context: t.Context(), ProjectRoot: options.ProjectRoot, DataDir: "relative"},
	} {
		if _, err := NewProvisioning(invalid); !errors.Is(err, ErrBinding) {
			t.Fatal("invalid provisioning assembly was accepted", err)
		}
	}
	provisioning, _ := NewProvisioning(options)
	defer provisioning.Close()
	for _, raw := range []string{`{`, `[]`, `{"unexpected":true}`, `{"cpu":null}`, `{"cpu":65}`, `{"memoryGB":129}`, `{"diskGB":31}`} {
		if _, err := provisioning.Start(t.Context(), []byte(raw)); !errors.Is(err, ErrBinding) {
			t.Fatal("invalid provisioning input was accepted", err)
		}
	}
	linux, _ := platform.New("linux", nil, nil)
	options.Host = linux
	options.Providers = nil
	options.Run = nil
	unsupported, _ := NewProvisioning(options)
	defer unsupported.Close()
	if _, err := unsupported.Start(t.Context(), []byte(`{}`)); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal("unsupported host launched automatic setup", err)
	}
	if state := unsupported.ResumeMonitoring(); state.Running {
		t.Fatal("unsupported host resumed a VM creator")
	}
}
