package computer

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func inspectionResult(state string) []byte {
	return []byte(`{"ok":true,"provider":"hyperv","vmId":"12345678-1234-1234-1234-123456789abc","state":"` + state + `","changed":false}`)
}

func TestLifecycleInspectionObservesOwnedPowerWithoutCreatingOrCompletingReceipts(t *testing.T) {
	for _, state := range []string{"running", "suspended", "off"} {
		for _, retained := range []bool{false, true} {
			t.Run(state+"/retained="+strconv.FormatBool(retained), func(t *testing.T) {
				calls := 0
				var original []byte
				var directory string
				lifecycle, root := ownedLifecycleFixture(t, func(_ context.Context, _ string, args []string, _ io.Reader) ([]byte, error) {
					calls++
					if !strings.Contains(strings.Join(args, "|"), "-Action|inspect|") {
						t.Fatal("inspection launched a power action")
					}
					actual, err := os.ReadFile(filepath.Join(directory, "vm-lifecycle.json"))
					if retained && (err != nil || !bytes.Equal(actual, original)) ||
						!retained && !errors.Is(err, os.ErrNotExist) {
						t.Fatal("inspection wrote a lifecycle intent")
					}
					return inspectionResult(state), nil
				})
				directory = root
				binding, err := lifecycle.binding()
				if err != nil {
					t.Fatal(err)
				}
				before, _ := os.ReadFile(filepath.Join(directory, "vm.json"))
				if retained {
					original = []byte(`{"version":1,"phase":"suspending","provider":"hyperv","binding":"` + binding.digest + `","vmId":"12345678-1234-1234-1234-123456789abc","operationId":"11111111-1111-4111-8111-111111111111","expiresAt":1}`)
					if err := os.WriteFile(lifecycle.file, original, 0600); err != nil {
						t.Fatal(err)
					}
				}

				result, err := lifecycle.Inspect(t.Context())
				if err != nil ||
					!result.OK ||
					!result.Supported ||
					string(result.State) != state ||
					calls != 1 {
					t.Fatal("fresh read-only observation was not confirmed", result, err)
				}
				after, _ := os.ReadFile(filepath.Join(directory, "vm.json"))
				receipt, receiptErr := os.ReadFile(lifecycle.file)
				if !bytes.Equal(before, after) ||
					retained && (receiptErr != nil || !bytes.Equal(receipt, original)) ||
					!retained && !errors.Is(receiptErr, os.ErrNotExist) {
					t.Fatal("inspection replaced the binding or changed prior unknown operation evidence")
				}
			})
		}
	}
}

func TestLifecycleInspectionRejectsUnconfirmedMalformedChangedAndCancelledObservations(t *testing.T) {
	for _, failure := range []string{"malformed", "unknown-state", "changed", "missing-changed", "wrong-provider", "addresses", "permission", "binding", "receipt", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			calls := 0
			var directory string
			lifecycle, root := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls++
				result := inspectionResult("suspended")
				switch failure {
				case "malformed":
					return []byte("{"), nil
				case "unknown-state":
					return inspectionResult("saving"), nil
				case "changed":
					return bytes.ReplaceAll(result, []byte(`"changed":false`), []byte(`"changed":true`)), nil
				case "missing-changed":
					return bytes.ReplaceAll(result, []byte(`,"changed":false`), nil), nil
				case "wrong-provider":
					return bytes.ReplaceAll(result, []byte("hyperv"), []byte("vmware")), nil
				case "addresses":
					return bytes.ReplaceAll(result, []byte(`"changed":false`), []byte(`"changed":false,"addresses":["192.0.2.1"]`)), nil
				case "permission":
					return nil, errors.New("synthetic permission refusal")
				case "binding":
					if err := os.WriteFile(filepath.Join(directory, "vm.json"), []byte(`{}`), 0600); err != nil {
						t.Fatal(err)
					}
				case "receipt":
					if err := os.WriteFile(filepath.Join(directory, "vm-lifecycle.json"), []byte(`{}`), 0600); err != nil {
						t.Fatal(err)
					}
				case "cancelled":
					cancel()
				}
				return result, nil
			})
			directory = root
			if result, err := lifecycle.Inspect(ctx); err == nil || result.OK || result.Supported || calls != 1 {
				t.Fatal("inspection accepted an unconfirmed outcome or retried it", result, err)
			}
			if failure != "receipt" {
				if _, err := os.Stat(lifecycle.file); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("failed inspection created a lifecycle receipt")
				}
			} else if raw, err := os.ReadFile(lifecycle.file); err != nil || string(raw) != `{}` {
				t.Fatal("inspection overwrote replacement receipt evidence")
			}
		})
	}
}

func TestLifecycleInspectionRejectsForeignReceiptsAndPreCancelledWorkWithoutACommand(t *testing.T) {
	lifecycle, directory := ownedLifecycleFixture(t, func(context.Context, string, []string, io.Reader) ([]byte, error) {
		t.Fatal("unadmitted inspection reached the process boundary")
		return nil, nil
	})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := lifecycle.Inspect(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("inspection ignored cancellation", err)
	}
	binding, _ := lifecycle.binding()
	raw := []byte(`{"version":1,"phase":"suspended","provider":"hyperv","binding":"` + strings.Repeat("f", 64) + `","vmId":null}`)
	if binding.digest == strings.Repeat("f", 64) || os.WriteFile(lifecycle.file, raw, 0600) != nil {
		t.Fatal("fixture failed to establish a different receipt owner")
	}
	if _, err := lifecycle.Inspect(t.Context()); err == nil {
		t.Fatal("inspection inherited another binding's receipt identity")
	}
	if actual, _ := os.ReadFile(filepath.Join(directory, "vm-lifecycle.json")); !bytes.Equal(actual, raw) {
		t.Fatal("foreign receipt was rewritten")
	}
	if err := os.Remove(lifecycle.file); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directory, "vm-setup-status.json")); err != nil {
		t.Fatal(err)
	}
	result, err := lifecycle.Inspect(t.Context())
	if err != nil || !result.OK || result.Supported || result.State != "" {
		t.Fatal("arbitrary SSH connection acquired managed power proof", err)
	}
}
