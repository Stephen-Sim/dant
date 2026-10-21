package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestLifecycleRejectsInvalidAssemblyAndUntrustedPersistedIdentityBeforeCommands(t *testing.T) {
	root := t.TempDir()
	for _, options := range []LifecycleOptions{
		{DataDir: "relative", ProjectRoot: root},
		{DataDir: root, ProjectRoot: "relative"},
		{DataDir: root, ProjectRoot: root, Timeout: -time.Second},
		{DataDir: root, ProjectRoot: root, Timeout: VMOperationTimeout + time.Second},
	} {
		if _, err := NewLifecycle(options); err == nil {
			t.Fatal("invalid lifecycle assembly was accepted")
		}
	}
	for _, raw := range []string{`{`, `[]`, `{"keyPath":3}`, `{"host":"a","host":"b"}`} {
		lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
			t.Fatal("invalid persisted identity reached a power command")
			return nil, nil
		})
		if err := os.WriteFile(filepath.Join(directory, "vm.json"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := lifecycle.Suspend(t.Context()); err == nil {
			t.Fatal("untrusted persisted identity was accepted")
		}
	}
}

func TestLifecycleInvalidReceiptCannotAuthorizeSuspendOrResume(t *testing.T) {
	for _, variant := range []string{"directory", "malformed", "version", "phase", "provider", "binding", "vm identity", "incomplete operation"} {
		t.Run(variant, func(t *testing.T) {
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				t.Fatal("invalid receipt reached a power command")
				return nil, nil
			})
			receipt := map[string]any{
				"version": 1, "phase": contracts.VmReceiptPhaseSuspended,
				"provider": contracts.VmProviderIdHyperV, "binding": strings.Repeat("a", 64),
			}
			switch variant {
			case "version":
				receipt["version"] = 2
			case "phase":
				receipt["phase"] = "unknown-phase"
			case "provider":
				receipt["provider"] = contracts.VmProviderIdSsh
			case "binding":
				receipt["binding"] = "invalid"
			case "vm identity":
				receipt["vmId"] = "invalid"
			case "incomplete operation":
				receipt["operationId"] = "12345678-1234-1234-1234-123456789abc"
			}
			file := filepath.Join(directory, "vm-lifecycle.json")
			if variant == "directory" {
				if err := os.Mkdir(file, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				raw, _ := json.Marshal(receipt)
				if variant == "malformed" {
					raw = []byte(`{`)
				}
				if err := os.WriteFile(file, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := lifecycle.Suspend(t.Context()); err == nil {
				t.Fatal("invalid receipt authorized suspension")
			}
			if _, err := lifecycle.Resume(t.Context()); err == nil {
				t.Fatal("invalid receipt authorized resume")
			}
		})
	}
}

func TestLifecycleRejectsMalformedCommandProofAndRevokesOnlyItsOwnIntent(t *testing.T) {
	for _, variant := range []string{"malformed", "oversized", "not ok", "foreign provider", "foreign vm", "unknown state", "missing changed", "duplicate address", "too many addresses", "running after suspend", "intent replaced"} {
		t.Run(variant, func(t *testing.T) {
			var directory string
			lifecycle, data := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				var result map[string]json.RawMessage
				_ = json.Unmarshal(commandResult("suspended", nil), &result)
				switch variant {
				case "malformed":
					return []byte(`{`), nil
				case "oversized":
					return []byte(strings.Repeat("x", commandReceiptMaxBytes+1)), nil
				case "not ok":
					result["ok"] = json.RawMessage(`false`)
				case "foreign provider":
					result["provider"] = json.RawMessage(`"vmware"`)
				case "foreign vm":
					result["vmId"] = json.RawMessage(`"invalid"`)
				case "unknown state":
					result["state"] = json.RawMessage(`"unknown-state"`)
				case "missing changed":
					delete(result, "changed")
				case "duplicate address":
					result["addresses"] = json.RawMessage(`["192.0.2.1","192.0.2.1"]`)
				case "too many addresses":
					addresses := make([]string, maxGuestAddresses+1)
					for index := range addresses {
						addresses[index] = "192.0.2.1"
					}
					result["addresses"], _ = json.Marshal(addresses)
				case "running after suspend":
					result["state"] = json.RawMessage(`"running"`)
				case "intent replaced":
					file := filepath.Join(directory, "vm-lifecycle.json")
					raw, _ := os.ReadFile(file)
					var receipt lifecycleReceipt
					_ = json.Unmarshal(raw, &receipt)
					receipt.OperationID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
					raw, _ = json.Marshal(receipt)
					if err := os.WriteFile(file, raw, 0600); err != nil {
						t.Error(err)
					}
				}
				return json.Marshal(result)
			})
			directory = data
			if _, err := lifecycle.Suspend(t.Context()); err == nil {
				t.Fatal("incomplete or foreign power proof was accepted")
			}
			receipt, err := lifecycle.receipt()
			if err != nil || receipt == nil {
				t.Fatal("unknown power result lost its durable receipt", err)
			}
			if variant == "intent replaced" && receipt.OperationID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
				t.Fatal("an obsolete operation revoked a replacement intent")
			}
		})
	}
}

func TestOwnedVMwareLifecycleRequiresManifestAndAnnotationAndPreservesItsDisk(t *testing.T) {
	for _, variant := range []string{
		"owned", "bad owner", "unknown phase", "missing vmx", "missing disk", "foreign annotation",
		"foreign vmx", "foreign disk", "hardlinked vmx reference", "hardlinked disk reference",
	} {
		t.Run(variant, func(t *testing.T) {
			calls := 0
			lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				var result map[string]json.RawMessage
				_ = json.Unmarshal(commandResult("suspended", nil), &result)
				result["provider"] = json.RawMessage(`"vmware"`)
				result["vmId"] = json.RawMessage(`"12345678-1234-4234-8234-123456789abc"`)
				return json.Marshal(result)
			})
			binding, _ := ReadBinding(directory)
			binding.Provider = contracts.VmProviderIdVMware
			binding.VMwareID = "12345678-1234-4234-8234-123456789abc"
			binding.VMXPath = filepath.Join(directory, "dant.vmx")
			raw, _ := json.Marshal(binding)
			_ = os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600)
			manifest := map[string]any{
				"owner": "dant-vmware-v1", "provider": contracts.VmProviderIdVMware, "version": 1,
				"id": binding.VMwareID, "vmx": binding.VMXPath, "disk": filepath.Join(directory, "dant.vmdk"), "phase": "connected",
			}
			if variant == "bad owner" {
				manifest["owner"] = "another-owner"
			}
			if variant == "unknown phase" {
				manifest["phase"] = "unknown"
			}
			if variant != "missing vmx" {
				annotation := `annotation = "dant-vmware-v1:` + binding.VMwareID + `"`
				if variant == "foreign annotation" {
					annotation = `annotation = "another-owner"`
				}
				_ = os.WriteFile(binding.VMXPath, []byte(annotation+"\n"), 0600)
			}
			disk := filepath.Join(directory, "dant.vmdk")
			if variant != "missing disk" {
				if err := os.WriteFile(disk, []byte("preserved owned disk"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, file := range []struct {
				field string
				owned string
			}{
				{"vmx", binding.VMXPath},
				{"disk", disk},
			} {
				foreign := filepath.Join(directory, "foreign-"+filepath.Base(file.owned))
				if variant == "foreign "+file.field {
					data, err := os.ReadFile(file.owned)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(foreign, data, 0600); err != nil {
						t.Fatal(err)
					}
					manifest[file.field] = foreign
				} else if variant == "hardlinked "+file.field+" reference" {
					if err := os.Link(file.owned, foreign); err != nil {
						t.Fatal(err)
					}
					manifest[file.field] = foreign
				}
			}
			raw, _ = json.Marshal(manifest)
			if err := os.WriteFile(filepath.Join(directory, "manifest.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}

			result, err := lifecycle.Suspend(t.Context())
			if variant == "owned" {
				if err != nil || !result.Supported || !result.VMSuspended || calls != 1 {
					t.Fatal("owned VMware proof could not suspend through the fixed helper", err)
				}
			} else if err != nil || result.Supported || calls != 0 {
				t.Fatal("unowned VMware metadata authorized a power action", err)
			}
			if variant == "missing disk" {
				if _, err := os.Stat(disk); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("identity validation created the absent managed disk", err)
				}
			} else if raw, err := os.ReadFile(disk); err != nil || string(raw) != "preserved owned disk" {
				t.Fatal("power ownership validation modified the guest disk", err)
			}
		})
	}
}

func TestExplicitReconnectCanResumeOwnedVMWithoutInventingAutomaticStartupPermission(t *testing.T) {
	calls := 0
	lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls++
		return commandResult("running", nil), nil
	})
	result, err := lifecycle.ResumeForReconnect(t.Context())
	if err != nil || !result.OK || !result.Resumed || calls != 1 {
		t.Fatal("explicit reconnect could not resume the independently owned computer", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "vm-lifecycle.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("confirmed reconnect retained a stale power intent", err)
	}
}
