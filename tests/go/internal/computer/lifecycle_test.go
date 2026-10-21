package computer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func ownedLifecycleFixture(t *testing.T, run CommandRunner) (*VMLifecycle, string) {
	t.Helper()
	directory := t.TempDir()
	key := filepath.Join(directory, "vm-key")
	for file, content := range map[string]string{"vm-key": "fixture private key", "vm-setup-status.json": `{"stage":"ready","name":"owned-fixture"}`, "vm/dant.vhdx": "fixture disk"} {
		name := filepath.Join(directory, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeBinding := func(host string) {
		raw, _ := json.Marshal(Binding{Host: host, User: "dant", Port: 22, KeyPath: key, KnownHosts: filepath.Join(directory, "known_hosts"), Provider: contracts.VmProviderIdHyperV, Name: "owned-fixture"})
		if err := os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeBinding("192.0.2.1")
	host := windowsComputerHost(t, nil)
	id := 0
	lifecycle, err := NewLifecycle(LifecycleOptions{DataDir: directory, ProjectRoot: directory, Host: host, Run: run, ID: func() string { id++; return fmt.Sprintf("12345678-1234-1234-1234-%012d", id) }})
	if err != nil {
		t.Fatal(err)
	}

	return lifecycle, directory
}

func commandResult(state string, addresses []string) []byte {
	raw, _ := json.Marshal(struct {
		OK        bool     `json:"ok"`
		Provider  string   `json:"provider"`
		VMID      string   `json:"vmId"`
		State     string   `json:"state"`
		Changed   bool     `json:"changed"`
		Addresses []string `json:"addresses,omitempty"`
	}{true, "hyperv", "12345678-1234-1234-1234-123456789abc", state, true, addresses})
	return raw
}

func TestLifecyclePersistsProofAndRefreshesOnlyConfirmedOwnedDHCP(t *testing.T) {
	calls := 0
	lifecycle, directory := ownedLifecycleFixture(t, func(_ context.Context, command string, args []string, _ io.Reader) ([]byte, error) {
		calls++
		if command != "powershell.exe" || !strings.Contains(strings.Join(args, "|"), "-ExpectedOperation|") {
			t.Fatal("owned operation proof missing")
		}
		if calls == 1 {
			return commandResult("suspended", nil), nil
		}
		return commandResult("running", []string{"192.0.2.22"}), nil
	})
	if result, err := lifecycle.Resume(context.Background()); err != nil || result.Resumed || calls != 0 {
		t.Fatal("normal startup must not resume without receipt")
	}

	if result, err := lifecycle.Suspend(context.Background()); err != nil || !result.VMSuspended {
		t.Fatalf("suspend: %+v %v", result, err)
	}
	receipt, err := lifecycle.receipt()
	if err != nil || receipt == nil || receipt.Phase != contracts.VmReceiptPhaseSuspended || receipt.VMID == nil {
		t.Fatal("confirmed power receipt not durable")
	}

	if result, err := lifecycle.Resume(context.Background()); err != nil || !result.Resumed {
		t.Fatal("resume proof failed")
	}

	if _, err := os.Stat(filepath.Join(directory, "vm-lifecycle.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("exact completed intent not cleared")
	}
	binding, err := ReadBinding(directory)
	if err != nil || binding.Host != "192.0.2.22" {
		t.Fatal("confirmed single DHCP endpoint not refreshed")
	}
}

func TestLifecycleUnknownOutcomeRevokesLateAuthorizationAndNeverRetries(t *testing.T) {
	calls := 0
	lifecycle, _ := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls++
		return nil, errors.New("untrusted private process error")
	})
	if _, err := lifecycle.Suspend(context.Background()); err == nil || err.Error() != "vm_lifecycle_unconfirmed" {
		t.Fatal("unknown result not preserved")
	}
	receipt, err := lifecycle.receipt()
	if err != nil || receipt == nil || receipt.ExpiresAt != 1 || receipt.OperationID == "12345678-1234-1234-1234-000000000001" {
		t.Fatal("timed out authorization not durably revoked")
	}

	if calls != 1 {
		t.Fatal("unconfirmed power action retried")
	}
}

func TestLifecycleRejectsChangedBindingAndInvalidGuestAddresses(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "169.254.1.1", "224.0.0.1", "::1"} {
		lifecycle, _ := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
			return commandResult("suspended", []string{address}), nil
		})
		if _, err := lifecycle.Suspend(context.Background()); err == nil {
			t.Fatal("unsafe guest endpoint accepted")
		}
	}
	var directory string
	lifecycle, root := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		if err := os.WriteFile(filepath.Join(directory, "vm.json"), []byte(`{"host":"changed"}`), 0600); err != nil {
			t.Fatal(err)
		}
		return commandResult("suspended", nil), nil
	})
	directory = root
	if _, err := lifecycle.Suspend(context.Background()); err == nil || err.Error() != "vm_lifecycle_binding_changed" {
		t.Fatal("stale connection identity accepted")
	}
}

func TestArbitrarySSHVMIsNeverPowerManaged(t *testing.T) {
	lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		t.Fatal("unowned VM command launched")
		return nil, nil
	})
	if err := os.Remove(filepath.Join(directory, "vm-setup-status.json")); err != nil {
		t.Fatal(err)
	}

	if result, err := lifecycle.Suspend(context.Background()); err != nil || result.Supported || result.VMSuspended {
		t.Fatal("unowned VM advertised power management")
	}
}
