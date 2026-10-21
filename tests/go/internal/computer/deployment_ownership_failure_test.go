package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDeploymentAttemptFencesRejectUnreadableExistingAndCancelledMutations(t *testing.T) {
	for _, scenario := range []string{"unreadable receipt", "existing attempt", "invalid source", "cancelled write"} {
		t.Run(scenario, func(t *testing.T) {
			options, binding, _, fingerprint := deploymentContractOptions(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			options.Context = ctx
			deployer, err := NewDeployer(options)
			if err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(options.DataDir, "vm-update-attempts.json")
			switch scenario {
			case "unreadable receipt":
				if err := os.Mkdir(name, 0700); err != nil {
					t.Fatal(err)
				}
			case "existing attempt":
				if _, err := deployer.attempts(binding, fingerprint, "start"); err != nil {
					t.Fatal(err)
				}
			case "invalid source":
				fingerprint = "invalid"
			case "cancelled write":
				cancel()
			}
			before, _ := os.ReadFile(name)
			if _, err := deployer.attempts(binding, fingerprint, "start"); !errors.Is(err, ErrDeploymentUnconfirmed) {
				t.Fatal("rejected attempt fence claimed a new confirmed update", err)
			}
			current, _ := os.ReadFile(name)
			if string(current) != string(before) {
				t.Fatal("failed attempt mutation rewrote the last durable update evidence")
			}
		})
	}
}

func TestDeploymentProofRequiresAllExpectedFieldsEvenWhenTheObjectHasFourKeys(t *testing.T) {
	options, binding, _, _ := deploymentContractOptions(t)
	options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
		return []byte(`{"sha256":null,"active":false,"version":null,"unrecognized":true}`), nil
	}
	deployer, err := NewDeployer(options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deployer.remote(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) {
		t.Fatal("an unknown fourth property replaced the required worker-session proof", err)
	}
}

func TestDeploymentPreparationRejectsBusyCancelledAndMissingSourceBeforeUpload(t *testing.T) {
	options, binding, _, _ := deploymentContractOptions(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	options.Run = func(ctx context.Context, _ string, _ []string, _ io.Reader) ([]byte, error) {
		close(entered)
		select {
		case <-release:
			return nil, io.ErrUnexpectedEOF
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	deployer, err := NewDeployer(options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- deployer.Prepare(ctx, binding) }()
	joined := false
	defer func() {
		once.Do(func() { close(release) })
		if !joined {
			<-done
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("deployment inspection did not enter its owned boundary")
	}
	if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrBridgeBusy) {
		t.Fatal("overlapping deployment started an additional operation", err)
	}
	once.Do(func() { close(release) })
	err = <-done
	joined = true
	if !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("failed inspection was treated as permission to upload", err)
	}
	cancelled, stop := context.WithCancel(t.Context())
	stop()
	if err := deployer.Prepare(cancelled, binding); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled deployment began another inspection", err)
	}
	options.ProjectRoot = t.TempDir()
	options.Binding = nil
	options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
		t.Fatal("missing bundle started a process")
		return nil, nil
	}
	missing, err := NewDeployer(options)
	if err != nil {
		t.Fatal(err)
	}
	if err := missing.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("default dynamic binding admitted an unauthenticated source bundle", err)
	}
}

func TestDeploymentRechecksCapturedSourceAndLocalAttemptOwnershipBeforeUploading(t *testing.T) {
	for _, scenario := range []string{"staging directory unavailable", "binding changed after capture", "bundle changed after capture", "attempt replaced before submission", "archive removed before upload"} {
		t.Run(scenario, func(t *testing.T) {
			options, binding, manifest, _ := deploymentContractOptions(t)
			calls, uploads, bindingReads := 0, 0, 0
			options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
				calls++
				if input != nil {
					uploads++
					t.Fatal("invalidated local capture reached the installer")
				}
				return obsoleteDeploymentProof(t, manifest), nil
			}
			options.Binding = func() (Binding, error) {
				bindingReads++
				if bindingReads == 3 {
					switch scenario {
					case "binding changed after capture":
						changed := binding
						changed.Host = "192.0.2.88"
						return changed, nil
					case "bundle changed after capture":
						if err := os.WriteFile(filepath.Join(options.ProjectRoot, filepath.FromSlash(BundleManifestPath)), []byte(`{}`), 0600); err != nil {
							t.Fatal(err)
						}
					case "attempt replaced before submission":
						if err := os.WriteFile(filepath.Join(options.DataDir, "vm-update-attempts.json"), []byte(`{}`), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				return binding, nil
			}
			if scenario == "staging directory unavailable" {
				options.Quiescent = func(context.Context) error {
					retained := filepath.Join(t.TempDir(), "retained-data")
					if err := os.Rename(options.DataDir, retained); err != nil {
						return err
					}
					return os.WriteFile(options.DataDir, []byte("unrelated replacement"), 0600)
				}
			}
			var deployer *Deployer
			options.Changed = func() {
				if scenario != "archive removed before upload" || deployer.Status().Status != contracts.ServiceUpdateStatusUpdating {
					return
				}
				matches, err := filepath.Glob(filepath.Join(options.DataDir, "deploy-*", "source.tar"))
				if err != nil || len(matches) != 1 {
					t.Fatal("fixture did not find its exclusive deployment capture", err)
				}
				if err := os.Remove(matches[0]); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			deployer, err = NewDeployer(options)
			if err != nil {
				t.Fatal(err)
			}
			err = deployer.Prepare(t.Context(), binding)
			want := ErrDeploymentUnavailable
			if scenario == "binding changed after capture" {
				want = ErrBridgeChanged
			} else if strings.Contains(scenario, "attempt") || strings.Contains(scenario, "archive") {
				want = ErrDeploymentUnconfirmed
			}
			if !errors.Is(err, want) || calls != 1 || uploads != 0 {
				t.Fatal("invalidated capture was uploaded or its failure classification changed", err)
			}
		})
	}
}

func TestDeploymentConfirmationCannotClearChangedBindingOrUntrustedAttemptEvidence(t *testing.T) {
	for _, changedBinding := range []bool{false, true} {
		t.Run(map[bool]string{false: "attempt replaced after upload", true: "binding changed after confirmation"}[changedBinding], func(t *testing.T) {
			options, binding, manifest, fingerprint := deploymentContractOptions(t)
			inspections, uploads, bindingReads := 0, 0, 0
			options.Binding = func() (Binding, error) {
				bindingReads++
				if changedBinding && bindingReads >= 5 {
					changed := binding
					changed.Host = "192.0.2.99"
					return changed, nil
				}
				return binding, nil
			}
			options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
				if input != nil {
					uploads++
					_, err := io.Copy(io.Discard, input)
					return nil, err
				}
				inspections++
				if inspections == 1 {
					return obsoleteDeploymentProof(t, manifest), nil
				}
				if !changedBinding {
					if err := os.WriteFile(filepath.Join(options.DataDir, "vm-update-attempts.json"), []byte(`{}`), 0600); err != nil {
						return nil, err
					}
				}
				return json.Marshal(deployedSource{SHA256: &fingerprint, Active: true, Version: &manifest.Version, Session: deploymentSessionFixture(manifest)})
			}
			deployer, err := NewDeployer(options)
			if err != nil {
				t.Fatal(err)
			}
			err = deployer.Prepare(t.Context(), binding)
			want := ErrDeploymentUnconfirmed
			if changedBinding {
				want = ErrBridgeChanged
			}
			if !errors.Is(err, want) || uploads != 1 || inspections != 2 || deployer.Status().Confirmed {
				t.Fatal("late deployment confirmation published a different binding or erased changed evidence", err)
			}
			if _, err := os.Stat(filepath.Join(options.DataDir, "vm-update-attempts.json")); err != nil {
				t.Fatal("unconfirmed publication discarded its durable update fence", err)
			}
			if err := deployer.Prepare(t.Context(), binding); err == nil || uploads != 1 {
				t.Fatal("unreconciled deployment outcome was automatically uploaded again", err)
			}
		})
	}
}
