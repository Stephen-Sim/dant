package computer

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

func TestProviderDetectionAndSelectionDoNotReplaceConfiguredProvider(t *testing.T) {
	host := windowsComputerHost(t, nil)
	provider := NewProviders(host, ProviderDetection{FileExists: func(file string) bool {
		return strings.HasSuffix(file, "vmms.exe") || strings.HasSuffix(file, "Hyper-V.psd1")
	}, ReadRegistry: func(context.Context, string) (string, error) { return "", errors.New("fixture not installed") }})
	found, err := provider.Detect(context.Background())
	if err != nil || !found[0].Available || found[1].Available {
		t.Fatal("incorrect detected providers")
	}

	if _, err := SelectProvider("auto", contracts.VmProviderIdVMware, found[:]); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal("must not silently switch VMware to Hyper-V")
	}

	if selected, err := SelectProvider("auto", "", found[:]); err != nil || selected != contracts.VmProviderIdHyperV {
		t.Fatal("fresh automatic selection failed")
	}

	if _, err := SelectProvider("ssh", "", found[:]); !errors.Is(err, ErrProvider) {
		t.Fatal("SSH cannot become a managed provider")
	}
	linux, _ := platform.New("linux", nil, nil)
	noCommands := NewProviders(linux, ProviderDetection{FileExists: func(string) bool { t.Fatal("non-Windows discovery must not inspect Windows paths"); return false }})
	if found, err := noCommands.Detect(context.Background()); err != nil || found[0].Available || found[1].Available {
		t.Fatal("non-Windows managed VM advertised")
	}
}

func TestVMwareDetectionRequiresBothToolsAndFixedCommandPlans(t *testing.T) {
	host := windowsComputerHost(t, map[string]string{"InstallTools": `D:\Owned Tools`})
	provider := NewProviders(host, ProviderDetection{FileExists: func(file string) bool { return strings.HasPrefix(file, `D:\Owned Tools\`) }, ReadRegistry: func(context.Context, string) (string, error) { return `%InstallTools%`, nil }})
	found, err := provider.Detect(context.Background())
	if err != nil || !found[1].Available || found[1].Tools == nil {
		t.Fatal("registry-expanded installation not detected")
	}
	plan, err := provider.SetupPlan(contracts.VmProviderIdVMware, SetupInput{DataDir: `D:\dant user data`, CPU: 4, MemoryGB: 8, DiskGB: 40, AdminSudo: true, Tools: found[1].Tools})
	if err != nil || plan.Stage != contracts.ProvisioningStatusCreating || plan.Prepare.Script != "prepare-vmware.ps1" || plan.Prepare.Args[len(plan.Prepare.Args)-1] != "-AdminSudo" {
		t.Fatal("incorrect VMware setup plan")
	}
	input := LifecycleInput{ProjectRoot: "fixture-root", DataDir: "fixture-data", Action: "suspend", Binding: strings.Repeat("a", 64), OperationID: "12345678-1234-1234-1234-123456789abc", ExpiresAt: 1000, VMID: "owned-vm-id"}
	command, err := provider.LifecycleCommand(contracts.VmProviderIdVMware, input)
	if err != nil || command.Executable != "powershell.exe" || !reflect.DeepEqual(command.Args[len(command.Args)-2:], []string{"-ExpectedVmId", "owned-vm-id"}) {
		t.Fatal("operation proof lost from fixed command")
	}
	input.Binding = "unconfirmed"
	if _, err := provider.LifecycleCommand(contracts.VmProviderIdVMware, input); !errors.Is(err, ErrProvider) {
		t.Fatal("unconfirmed binding accepted")
	}
}
