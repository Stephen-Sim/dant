package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDeploymentArchiveRejectsExistingTargetsAndCancellationBeforeReadingSources(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, canonical, err := readBundle(root, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}
	network, err := config.ReadNetwork(nil)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "retained.tar")
	original := []byte("existing archive belongs to its original operation")
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeBundleTar(t.Context(), root, target, manifest, canonical, fingerprint, network); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("archive publication reused an existing target", err)
	}
	if raw, err := os.ReadFile(target); err != nil || !bytes.Equal(raw, original) {
		t.Fatal("rejected exclusive archive overwrote the previous operation", err)
	}
	public, err := config.PublicVMConfiguration(nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var output bytes.Buffer
	if err := writeBundleArchive(ctx, root, &output, manifest, canonical, fingerprint, public); !errors.Is(err, context.Canceled) || output.Len() != 0 {
		t.Fatal("cancelled archive read a source or published bytes", err)
	}
}

func TestUnsupportedSetupAndLifecycleCommandsCannotReachTheProcessBoundary(t *testing.T) {
	var calls atomic.Int32
	lifecycle, _ := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls.Add(1)
		return nil, io.ErrUnexpectedEOF
	})
	binding, err := lifecycle.binding()
	if err != nil || binding == nil {
		t.Fatal("missing isolated binding", err)
	}
	receipt := lifecycle.intent(lifecycleReceipt{Version: 1, Provider: contracts.VmProviderIdHyperV, Binding: binding.digest}, contracts.VmReceiptPhaseSuspending)
	_, err = lifecycle.command(t.Context(), "unrecognized-power-action", binding, receipt)
	var failure *LifecycleError
	if !errors.As(err, &failure) || failure.Reason != LifecycleReasonUnsupported || calls.Load() != 0 {
		t.Fatal("unsupported lifecycle action reached the process boundary", err)
	}

	options := provisioningContractOptions(t)
	options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls.Add(1)
		return nil, io.ErrUnexpectedEOF
	}
	provisioning, err := NewProvisioning(options)
	if err != nil {
		t.Fatal(err)
	}
	defer provisioning.Close()
	provisioning.wg.Add(1)
	go provisioning.run(SetupInput{DataDir: options.DataDir}, contracts.VmProviderIdSsh, false)
	provisioning.wg.Wait()
	state := provisioning.Snapshot()
	if state.Status != contracts.ProvisioningStatusFailed || state.Running || calls.Load() != 0 {
		t.Fatal("an unsupported setup plan launched a helper or retained an owner")
	}
}

func TestConfirmedPendingDeploymentRetainsItsFenceWhenTheOwningContextCannotCommit(t *testing.T) {
	options, binding, manifest, fingerprint := deploymentContractOptions(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	options.Context = ctx
	options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
		if input != nil {
			t.Fatal("reconciliation started an installer for an existing pending attempt")
		}
		cancel()
		return json.Marshal(deployedSource{SHA256: &fingerprint, Active: true, Version: &manifest.Version, Session: deploymentSessionFixture(manifest)})
	}
	deployer, err := NewDeployer(options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deployer.attempts(binding, fingerprint, "start"); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(options.DataDir, "vm-update-attempts.json")
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := deployer.Prepare(t.Context(), binding); err == nil || deployer.Status().Confirmed {
		t.Fatal("cancelled owning context acknowledged a durable reconciliation", err)
	}
	if after, err := os.ReadFile(name); err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed reconciliation discarded the pending attempt", err)
	}
}

func TestProvisioningCannotPublishReadyWhenTheObservedHelperCannotSaveItsReceipt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		options := provisioningContractOptions(t)
		data := profileFixture(t, "isolated-ready.invalid")
		options.DataDir = data
		writeProvisioningContractStatus(t, options, `{"stage":"guest-installing","provider":"hyperv"}`)
		var calls atomic.Int32
		options.Run = func(_ context.Context, _ string, args []string, _ io.Reader) ([]byte, error) {
			calls.Add(1)
			if len(args) < 2 || args[len(args)-2] != "-DataDirectory" || args[len(args)-1] != data {
				return nil, ErrProvisioningFailed
			}
			name := filepath.Join(data, "vm-setup-status.json")
			if err := os.Remove(name); err != nil {
				return nil, err
			}
			return nil, os.Mkdir(name, 0700)
		}
		provisioning, err := NewProvisioning(options)
		if err != nil {
			t.Fatal(err)
		}
		defer provisioning.Close()
		provisioning.wg.Add(1)
		go provisioning.run(SetupInput{}, contracts.VmProviderIdHyperV, true)
		synctest.Wait()
		state := provisioning.Snapshot()
		if calls.Load() != 1 || state.Status != contracts.ProvisioningStatusFailed || state.Running || state.Connection == nil {
			t.Fatal("failed ready receipt was treated as a completed installation", calls.Load(), state.Status)
		}
	})
}
