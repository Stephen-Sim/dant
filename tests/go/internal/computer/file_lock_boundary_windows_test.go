package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"golang.org/x/sys/windows"
)

func holdComputerFixtureFile(t *testing.T, name string, sharing uint32) {
	t.Helper()
	encoded, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(encoded, windows.GENERIC_READ, sharing, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal("isolated fixture file could not be held", err)
	}
	t.Cleanup(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error("isolated fixture handle did not close", err)
		}
	})
}

func TestWindowsArchiveCannotOpenALockedSourceAndRetainsItsOriginalBytes(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, canonical, err := readBundle(root, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(root, filepath.FromSlash(manifest.Files[0].Path))
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	public, err := config.PublicVMConfiguration(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("source held without read sharing", func(t *testing.T) {
		holdComputerFixtureFile(t, name, 0)
		var output bytes.Buffer
		if err := writeBundleArchive(t.Context(), root, &output, manifest, canonical, fingerprint, public); !errors.Is(err, ErrDeploymentUnavailable) || output.Len() != 0 {
			t.Fatal("locked source was copied or accepted as a complete archive", err)
		}
	})
	if after, err := os.ReadFile(name); err != nil || !bytes.Equal(after, before) {
		t.Fatal("failed source acquisition modified the verified input", err)
	}
}

func TestWindowsResumeRetainsItsIntentAndAddressWhenReceiptRemovalIsLocked(t *testing.T) {
	calls := 0
	var lifecycle *VMLifecycle
	var directory string
	lifecycle, directory = ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls++
		if calls == 1 {
			return commandResult("suspended", nil), nil
		}
		holdComputerFixtureFile(t, lifecycle.file, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
		return commandResult("running", []string{"192.0.2.89"}), nil
	})
	if _, err := lifecycle.Suspend(t.Context()); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, "vm.json"))
	if err != nil {
		t.Fatal(err)
	}
	if result, err := lifecycle.Resume(t.Context()); err == nil || result.OK || result.Resumed {
		t.Fatal("failed receipt removal was acknowledged as a completed resume", err)
	}
	receipt, err := lifecycle.receipt()
	if err != nil || receipt == nil || receipt.Phase != contracts.VmReceiptPhaseResuming || calls != 2 {
		t.Fatal("failed receipt retirement discarded intent or repeated the power action", err)
	}
	if after, err := os.ReadFile(filepath.Join(directory, "vm.json")); err != nil || !bytes.Equal(after, before) {
		t.Fatal("uncommitted resume changed the connection address", err)
	}
}

func TestWindowsVMwareOwnershipRequiresReadableAnnotationBeforeAnyPowerCommand(t *testing.T) {
	calls := 0
	lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls++
		return nil, io.ErrUnexpectedEOF
	})
	binding, err := ReadBinding(directory)
	if err != nil {
		t.Fatal(err)
	}
	binding.Provider = contracts.VmProviderIdVMware
	binding.VMwareID = "12345678-1234-4234-8234-123456789abc"
	binding.VMXPath = filepath.Join(directory, "dant.vmx")
	disk := filepath.Join(directory, "dant.vmdk")
	for name, raw := range map[string][]byte{
		binding.VMXPath: []byte(`annotation = "dant-vmware-v1:` + binding.VMwareID + `"`),
		disk:            []byte("owned fixture disk retained"),
	} {
		if err := os.WriteFile(name, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(binding)
	if err != nil || os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600) != nil {
		t.Fatal("isolated VMware binding was not saved", err)
	}
	manifest := struct {
		Owner    string                 `json:"owner"`
		Provider contracts.VmProviderId `json:"provider"`
		Version  int                    `json:"version"`
		ID       string                 `json:"id"`
		VMX      string                 `json:"vmx"`
		Disk     string                 `json:"disk"`
		Phase    string                 `json:"phase"`
	}{"dant-vmware-v1", contracts.VmProviderIdVMware, 1, binding.VMwareID, binding.VMXPath, disk, "connected"}
	raw, err = json.Marshal(manifest)
	if err != nil || os.WriteFile(filepath.Join(directory, "manifest.json"), raw, 0600) != nil {
		t.Fatal("isolated VMware manifest was not saved", err)
	}
	holdComputerFixtureFile(t, binding.VMXPath, 0)
	result, err := lifecycle.Suspend(t.Context())
	if err != nil || !result.OK || result.Supported || calls != 0 {
		t.Fatal("unreadable ownership annotation admitted a VM power operation", err)
	}
	if raw, err := os.ReadFile(disk); err != nil || string(raw) != "owned fixture disk retained" {
		t.Fatal("rejected VMware ownership removed its existing disk", err)
	}
}
