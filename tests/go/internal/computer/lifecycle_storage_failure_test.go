package computer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestLifecycleOpaqueOrUnownedBindingsNeverAuthorizePowerCommands(t *testing.T) {
	for _, mode := range []string{"missing-binding", "binding-directory", "unowned-key", "foreign-provider", "missing-manifest", "invalid-manifest", "missing-disk"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				return nil, errors.New("unowned power command must not execute")
			})
			name := filepath.Join(directory, "vm.json")
			raw, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			var binding contracts.RawObject
			if json.Unmarshal(raw, &binding) != nil {
				t.Fatal("invalid owned binding fixture")
			}
			switch mode {
			case "missing-binding", "binding-directory":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
				if mode == "binding-directory" {
					if err := os.Mkdir(name, 0700); err != nil {
						t.Fatal(err)
					}
				}
			case "unowned-key":
				binding["keyPath"], _ = json.Marshal(filepath.Join(directory, "different-key"))
			case "foreign-provider":
				binding["provider"] = json.RawMessage(`"ssh"`)
			case "missing-manifest", "invalid-manifest":
				binding["provider"] = json.RawMessage(`"vmware"`)
				if mode == "invalid-manifest" {
					if err := os.WriteFile(filepath.Join(directory, "manifest.json"), []byte("{"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			case "missing-disk":
				if err := os.Remove(filepath.Join(directory, "vm", "dant.vhdx")); err != nil {
					t.Fatal(err)
				}
			}
			if mode != "missing-binding" && mode != "binding-directory" {
				raw, err := json.Marshal(binding)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(name, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			result, suspendErr := lifecycle.Suspend(t.Context())
			resumed, resumeErr := lifecycle.ResumeForReconnect(t.Context())
			if mode == "binding-directory" {
				if suspendErr == nil || resumeErr == nil {
					t.Fatal("unreadable ownership was accepted")
				}
			} else if suspendErr != nil || resumeErr != nil || !result.OK || result.Supported || result.VMSuspended || !resumed.OK || resumed.Resumed {
				t.Fatal("unowned connection was advertised as a managed VM", suspendErr, resumeErr)
			}
			if calls != 0 {
				t.Fatal("opaque or unowned binding crossed the power boundary")
			}
		})
	}
}

func TestLifecycleOverlappingSuspendAndResumeCannotShareOnePowerIntent(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	var calls atomic.Int32
	lifecycle, _ := ownedLifecycleFixture(t, func(ctx context.Context, _ string, _ []string, _ io.Reader) ([]byte, error) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
			return commandResult("suspended", nil), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := lifecycle.Suspend(ctx)
		done <- err
	}()
	joined := false
	defer func() {
		releaseOnce.Do(func() { close(release) })
		if !joined {
			<-done
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("isolated power command did not enter")
	}
	for _, run := range []func(context.Context) error{
		func(ctx context.Context) error {
			_, err := lifecycle.Suspend(ctx)
			return err
		},
		func(ctx context.Context) error {
			_, err := lifecycle.ResumeForReconnect(ctx)
			return err
		},
	} {
		var failure *LifecycleError
		if err := run(ctx); !errors.As(err, &failure) || failure.Reason != LifecycleReasonBusy {
			t.Fatal("overlapping lifecycle operation was not rejected as busy", err)
		}
	}
	releaseOnce.Do(func() { close(release) })
	err := <-done
	joined = true
	if err != nil || calls.Load() != 1 {
		t.Fatal("one owned power intent was repeated or failed after overlap rejection", err)
	}
}

func TestLifecycleCancellationPreservesIntentOrOriginalAddressAtPublicationBoundaries(t *testing.T) {
	for _, action := range []string{"suspend", "resume"} {
		for _, afterPower := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/after-power-%t", action, afterPower), func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				calls := 0
				lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
					calls++
					if action == "resume" && calls == 1 {
						return commandResult("suspended", nil), nil
					}
					if afterPower {
						cancel()
					}
					if action == "resume" {
						return commandResult("running", []string{"192.0.2.22"}), nil
					}
					return commandResult("suspended", nil), nil
				})
				setupCalls := 0
				if action == "resume" {
					if _, err := lifecycle.Suspend(t.Context()); err != nil {
						t.Fatal(err)
					}
					setupCalls = 1
				}
				if !afterPower {
					cancel()
				}
				var err error
				if action == "suspend" {
					_, err = lifecycle.Suspend(ctx)
				} else {
					_, err = lifecycle.Resume(ctx)
				}
				wantedCalls := setupCalls
				if afterPower {
					wantedCalls++
				}
				if !errors.Is(err, context.Canceled) || calls != wantedCalls {
					t.Fatal("cancelled publication was confirmed or the power command was repeated", err)
				}
				binding, err := ReadBinding(directory)
				if err != nil || binding.Host != "192.0.2.1" {
					t.Fatal("failed address publication replaced the original connection", err)
				}
				if afterPower && action == "suspend" {
					receipt, err := lifecycle.receipt()
					if err != nil || receipt == nil || receipt.Phase != contracts.VmReceiptPhaseSuspending {
						t.Fatal("failed result publication lost durable power intent", err)
					}
				}
			})
		}
	}
}
