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

func TestProvisioningStartsOnlyFixedHelpersAndJoinsWithoutDeletingVMFiles(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	host, _ := platform.New("windows", nil, nil)
	providers := NewProviders(host, ProviderDetection{FileExists: func(string) bool { return true }, ReadRegistry: func(context.Context, string) (string, error) { return "", ErrProviderUnavailable }})
	var calls atomic.Int32
	ready := make(chan struct{}, 1)
	run := func(ctx context.Context, command string, args []string, input io.Reader) ([]byte, error) {
		calls.Add(1)
		script := ""
		for index, arg := range args {
			if arg == "-File" {
				script = filepath.Base(args[index+1])
				break
			}
		}
		switch script {
		case "prepare-vm.ps1":
		case "launch-vm.ps1":
			key := filepath.Join(data, "vm-key")
			os.WriteFile(key, []byte("isolated fixture key"), 0600)
			raw, _ := json.Marshal(Binding{Host: "fixture.invalid", User: "dant", Port: 22, KeyPath: key, KnownHosts: filepath.Join(data, "known_hosts"), Provider: contracts.VmProviderIdHyperV})
			os.WriteFile(filepath.Join(data, "vm.json"), raw, 0600)
		case "check-vm.ps1":
		default:
			t.Error("unexpected provisioning helper")
		}
		return []byte("untrusted process output must not enter state"), nil
	}
	provisioning, err := NewProvisioning(ProvisioningOptions{Context: context.Background(), ProjectRoot: root, DataDir: data, Host: host, Providers: providers, Run: run, InstallTimeout: 5 * time.Second, ProbeInterval: time.Millisecond, Changed: func() {
		select {
		case ready <- struct{}{}:
		default:
		}
	}})
	if err != nil {
		t.Fatal(err)
	}

	if calls.Load() != 0 {
		t.Fatal("constructor launched provisioning")
	}

	if _, err := provisioning.Start(context.Background(), []byte(`{"cpu":4,"memoryGB":8,"diskGB":40,"provider":"hyperv"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for provisioning.Snapshot().Status != contracts.ProvisioningStatusReady {
		select {
		case <-ready:
		case <-deadline.C:
			t.Fatal("fixture provisioning did not finish")
		}
	}
	provisioning.Close()
	state := provisioning.Snapshot()
	if calls.Load() != 3 || state.Running || state.Output != "" || state.Connection == nil {
		t.Fatal("provisioning lifecycle or bounded state changed")
	}

	if _, err := os.Lstat(filepath.Join(data, "vm.json")); err != nil {
		t.Fatal("close removed configured VM")
	}
}

func TestProvisioningPreservesExistingDisksAndRejectsInvalidInput(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	os.MkdirAll(filepath.Join(data, "vm"), 0700)
	os.WriteFile(filepath.Join(data, "vm", "existing.vhdx"), []byte("existing disk"), 0600)
	host, _ := platform.New("windows", nil, nil)
	providers := NewProviders(host, ProviderDetection{FileExists: func(string) bool { return true }, ReadRegistry: func(context.Context, string) (string, error) { return "", ErrProviderUnavailable }})
	var commands atomic.Int32
	provisioning, _ := NewProvisioning(ProvisioningOptions{Context: context.Background(), ProjectRoot: root, DataDir: data, Host: host, Providers: providers, Run: func(context.Context, string, []string, io.Reader) ([]byte, error) { commands.Add(1); return nil, nil }})
	defer provisioning.Close()
	for _, raw := range []string{`{"cpu":3.5}`, `{"memoryGB":1}`, `{"adminSudo":null}`, `{"provider":"arbitrary"}`} {
		if _, err := provisioning.Start(context.Background(), []byte(raw)); err == nil {
			t.Fatal("invalid provisioning request admitted")
		}
	}

	if _, err := provisioning.Start(context.Background(), []byte(`{"provider":"hyperv"}`)); !errors.Is(err, ErrProvisioningBusy) {
		t.Fatal("existing disk was not fenced")
	}

	if commands.Load() != 0 {
		t.Fatal("invalid or conflicting request launched helper")
	}
	content, _ := os.ReadFile(filepath.Join(data, "vm", "existing.vhdx"))
	if !strings.Contains(string(content), "existing") {
		t.Fatal("existing disk was changed")
	}
}
