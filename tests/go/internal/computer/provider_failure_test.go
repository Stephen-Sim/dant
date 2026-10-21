package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestProviderDiscoveryPreservesPartialToolsAndRejectsInvalidOrCancelledRegistryResults(t *testing.T) {
	for _, mode := range []string{"partial", "invalid-registry", "cancelled", "complete-standard-directory"} {
		t.Run(mode, func(t *testing.T) {
			host := windowsComputerHost(t, nil)
			ctx := t.Context()
			if mode == "cancelled" {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			providers := NewProviders(host, ProviderDetection{
				FileExists: func(file string) bool {
					if mode == "partial" {
						return strings.HasSuffix(file, "vmrun.exe")
					}
					return mode == "complete-standard-directory"
				},
				ReadRegistry: func(context.Context, string) (string, error) {
					if mode == "invalid-registry" {
						return "unresolved-relative-installation", nil
					}
					return "", ErrProviderUnavailable
				},
			})
			found, err := providers.Detect(ctx)
			if mode == "cancelled" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancelled discovery continued registry observation", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "partial" {
				if found[1].Available || found[1].Tools == nil || found[1].Tools.VMRun == nil || found[1].Tools.VDiskManager != nil || found[1].Reason == nil {
					t.Fatal("one installed VMware tool was promoted to a complete installation")
				}
			} else if found[1].Available != (mode == "complete-standard-directory") {
				t.Fatal("provider discovery ignored captured installation evidence")
			}
		})
	}
	host := windowsComputerHost(t, nil)
	providers := NewProviders(host, ProviderDetection{ReadRegistry: func(context.Context, string) (string, error) { return "", ErrProviderUnavailable }})
	file := filepath.Join(t.TempDir(), "isolated-existing-file")
	if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !providers.detection.FileExists(file) || providers.detection.FileExists(filepath.Dir(file)) || providers.detection.FileExists(file+".missing") {
		t.Fatal("default file observation did not require an existing regular file")
	}
	if _, err := providers.Capabilities(contracts.VmProviderId("unrecognized")); !errors.Is(err, ErrProvider) {
		t.Fatal("unknown provider acquired capabilities", err)
	}
	if _, err := providers.SetupPlan(contracts.VmProviderIdVMware, SetupInput{DataDir: t.TempDir(), Tools: &HypervisorTools{VMRun: pointer("isolated-vmrun")}}); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal("partial VMware installation received a setup plan", err)
	}
	if _, err := SelectProvider("auto", "", nil); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal("automatic selection invented an available provider", err)
	}
}

func TestDefaultTunnelAndRegistryAdaptersRespectCancellationBeforeStartingHostCommands(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if tunnel, err := openSSHTunnel(ctx, Binding{Host: "fixture.invalid", User: "fixture"}); !errors.Is(err, ErrSessionUnavailable) || tunnel != nil {
		t.Fatal("cancelled tunnel attempted or advertised a live SSH process", err)
	}
	host := windowsComputerHost(t, nil)
	providers := NewProviders(host, ProviderDetection{})
	if _, err := providers.detection.ReadRegistry(ctx, "synthetic-registry-key"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled registry adapter started its host command", err)
	}
	bridge, err := NewBridge(BridgeOptions{Context: t.Context(), DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	if bridge.options.HTTP.CheckRedirect(nil, nil) == nil {
		t.Fatal("default local bridge transport allowed redirects")
	}
}
