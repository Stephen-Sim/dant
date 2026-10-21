package computer

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestProvisioningRejectsLateClosureAndExistingInvalidOrConflictingFilesBeforeHelpers(t *testing.T) {
	for _, mode := range []string{"closed", "invalid-binding", "vm-file", "awaiting-admin", "status-directory"} {
		t.Run(mode, func(t *testing.T) {
			options := provisioningContractOptions(t)
			if err := os.MkdirAll(options.DataDir, 0o700); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "invalid-binding":
				if err := os.WriteFile(filepath.Join(options.DataDir, "vm.json"), []byte("invalid preserved binding"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "vm-file":
				if err := os.WriteFile(filepath.Join(options.DataDir, "vm"), []byte("existing artifact"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "awaiting-admin":
				writeProvisioningContractStatus(t, options, `{"stage":"awaiting-admin"}`)
			case "status-directory":
				if err := os.Mkdir(filepath.Join(options.DataDir, "vm-setup-status.json"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			provisioning, err := NewProvisioning(options)
			if err != nil {
				t.Fatal(err)
			}
			defer provisioning.Close()
			if mode == "closed" {
				provisioning.Close()
			}
			if _, err := provisioning.Start(t.Context(), []byte(`{"provider":"hyperv"}`)); err == nil {
				t.Fatal("closed or conflicting setup admitted a helper")
			}
		})
	}
	options := provisioningContractOptions(t)
	options.Providers = NewProviders(options.Host, ProviderDetection{FileExists: func(string) bool { return false }, ReadRegistry: func(context.Context, string) (string, error) {
		t.Fatal("cancelled inventory reached registry")
		return "", nil
	}})
	provisioning, err := NewProvisioning(options)
	if err != nil {
		t.Fatal(err)
	}
	defer provisioning.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := provisioning.Start(ctx, []byte(`{}`)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled provider inventory was reported as setup admission", err)
	}
	if err := provisioning.execute(t.Context(), ScriptCommand{Script: "untrusted-helper.ps1"}); !errors.Is(err, ErrProvider) {
		t.Fatal("an unlisted helper reached the command boundary", err)
	}
	if state := provisioning.ResumeMonitoring(); state.Running {
		t.Fatal("idle provisioning invented an in-progress monitor")
	}
}

func TestProvisioningPhaseWritesAndIndependentlyObservedTerminalStatusAreNotRetried(t *testing.T) {
	for _, mode := range []string{"phase-write-failure", "independent-ready", "independent-failed"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				options := provisioningContractOptions(t)
				var commands atomic.Int32
				options.Run = func(_ context.Context, _ string, args []string, _ io.Reader) ([]byte, error) {
					commands.Add(1)
					script := ""
					for index, argument := range args {
						if argument == "-File" && index+1 < len(args) {
							script = filepath.Base(args[index+1])
						}
					}
					if script == "prepare-vm.ps1" && mode == "phase-write-failure" {
						file := filepath.Join(options.DataDir, "vm-setup-status.json")
						if err := os.Remove(file); err != nil {
							return nil, err
						}
						return nil, os.Mkdir(file, 0o700)
					}
					if script == "launch-vm.ps1" {
						stage := "ready"
						if mode == "independent-failed" {
							stage = "failed:isolated observed failure"
						}
						writeProvisioningContractStatus(t, options, `{"stage":"`+stage+`"}`)
					}
					return nil, nil
				}
				provisioning, err := NewProvisioning(options)
				if err != nil {
					t.Fatal(err)
				}
				defer provisioning.Close()
				if _, err := provisioning.Start(t.Context(), []byte(`{"provider":"hyperv"}`)); err != nil {
					t.Fatal(err)
				}
				synctest.Wait()
				state := provisioning.Snapshot()
				want, wantCalls := contracts.ProvisioningStatusFailed, int32(2)
				if mode == "independent-ready" {
					want = contracts.ProvisioningStatusReady
				} else if mode == "phase-write-failure" {
					wantCalls = 1
				}
				if state.Running || state.Status != want || commands.Load() != wantCalls {
					t.Fatal("setup phase failure was hidden or later commands repeated", state.Status, state.Running, commands.Load())
				}
			})
		})
	}
}

func TestProvisioningPollingUsesVirtualTimeAndJoinsWithoutRepeatingCreation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		options := provisioningContractOptions(t)
		options.InstallTimeout = 10 * time.Second
		writeProvisioningContractStatus(t, options, `{"stage":"awaiting-admin","provider":"hyperv"}`)
		var changed atomic.Int32
		options.Changed = func() { changed.Add(1) }
		provisioning, err := NewProvisioning(options)
		if err != nil {
			t.Fatal(err)
		}
		defer provisioning.Close()
		if !provisioning.ResumeMonitoring().Running {
			t.Fatal("known setup could not resume observation")
		}
		synctest.Wait()
		before := changed.Load()
		time.Sleep(provisioningPollInterval + time.Millisecond)
		synctest.Wait()
		if changed.Load() <= before {
			t.Fatal("owned polling ticker did not publish its bounded observation")
		}
		provisioning.Close()
		if provisioning.Snapshot().Running {
			t.Fatal("closed polling owner remained active")
		}
	})
}
