// Package computer owns VM connections and power operations, never task execution.
package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const registryTimeout = 3 * time.Second
const windowsRequired = "Automatic VM setup requires Windows."

var ErrProvider = errors.New("vm_provider_invalid")
var ErrProviderUnavailable = errors.New("vm_provider_unavailable")

type ProviderCapabilities struct {
	AutomaticSetup     bool `json:"automaticSetup"`
	PowerLifecycle     bool `json:"powerLifecycle"`
	ExistingConnection bool `json:"existingConnection"`
}

type HypervisorTools struct {
	Directory    string  `json:"directory"`
	VMRun        *string `json:"vmrun"`
	VDiskManager *string `json:"vdiskmanager"`
}

type Hypervisor struct {
	ID        contracts.VmProviderId `json:"id"`
	Label     string                 `json:"label"`
	Available bool                   `json:"available"`
	Reason    *string                `json:"reason"`
	Tools     *HypervisorTools       `json:"tools,omitempty"`
}

type ProviderDetection struct {
	FileExists   func(string) bool
	ReadRegistry func(context.Context, string) (string, error)
}

type Providers struct {
	host      platform.Host
	detection ProviderDetection
}

func NewProviders(host platform.Host, detection ProviderDetection) *Providers {
	if detection.FileExists == nil {
		detection.FileExists = func(file string) bool {
			stat, err := os.Stat(file)
			return err == nil && stat.Mode().IsRegular()
		}
	}

	if detection.ReadRegistry == nil {
		detection.ReadRegistry = func(ctx context.Context, key string) (string, error) {
			ctx, cancel := context.WithTimeout(ctx, registryTimeout)
			defer cancel()
			output, err := platform.Run(ctx, host.Commands.Registry, []string{"query", key, "/v", "InstallPath"}, nil)
			if err != nil {
				return "", err
			}
			matches := regexp.MustCompile(`(?im)\bInstallPath\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)`).FindSubmatch(output)
			if len(matches) != 2 {
				return "", ErrProviderUnavailable
			}
			return strings.TrimSpace(string(matches[1])), nil
		}
	}

	return &Providers{host: host, detection: detection}
}

func (providers *Providers) Capabilities(id contracts.VmProviderId) (ProviderCapabilities, error) {
	if !id.Valid() {
		return ProviderCapabilities{}, ErrProvider
	}
	managed := id != contracts.VmProviderIdSsh && providers.host.Capabilities.ManagedVM
	return ProviderCapabilities{AutomaticSetup: managed, PowerLifecycle: managed, ExistingConnection: providers.host.Capabilities.ExistingSSH}, nil
}

func pointer(value string) *string { return &value }

func (providers *Providers) Detect(ctx context.Context) ([2]Hypervisor, error) {
	results := [2]Hypervisor{{ID: contracts.VmProviderIdHyperV, Label: "Hyper-V"}, {ID: contracts.VmProviderIdVMware, Label: "VMware Workstation"}}
	if !providers.host.Capabilities.ManagedVM || providers.host.Windows == nil {
		for index := range results {
			results[index].Reason = pointer(windowsRequired)
		}
		return results, nil
	}
	configuration := providers.host.Windows
	results[0].Available = providers.detection.FileExists(configuration.HyperVService) && providers.detection.FileExists(configuration.HyperVModule)
	if !results[0].Available {
		results[0].Reason = pointer("Hyper-V and its management tools are not installed. Enable Hyper-V or choose VMware Workstation.")
	}
	inspect := func(directory string) *HypervisorTools {
		expanded, err := configuration.ExpandDirectory(directory)
		if err != nil {
			return nil
		}
		tools := &HypervisorTools{Directory: expanded}
		if file := expanded + `\vmrun.exe`; providers.detection.FileExists(file) {
			tools.VMRun = pointer(file)
		}
		if file := expanded + `\vmware-vdiskmanager.exe`; providers.detection.FileExists(file) {
			tools.VDiskManager = pointer(file)
		}
		return tools
	}
	var partial *HypervisorTools
	accept := func(tools *HypervisorTools) bool {
		if tools == nil {
			return false
		}
		if tools.VMRun != nil && tools.VDiskManager != nil {
			results[1].Available = true
			results[1].Tools = tools
			return true
		}
		if tools.VMRun != nil || tools.VDiskManager != nil {
			partial = tools
		}
		return false
	}
	for _, directory := range configuration.VMwareDirectories {
		if accept(inspect(directory)) {
			return results, nil
		}
	}
	for _, key := range []string{`HKLM\SOFTWARE\VMware, Inc.\VMware Workstation`, `HKLM\SOFTWARE\WOW6432Node\VMware, Inc.\VMware Workstation`, `HKCU\SOFTWARE\VMware, Inc.\VMware Workstation`} {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		directory, err := providers.detection.ReadRegistry(ctx, key)
		if err == nil && accept(inspect(directory)) {
			return results, nil
		}
	}
	results[1].Tools = partial
	if partial != nil {
		results[1].Reason = pointer("The VMware Workstation installation is incomplete: vmrun and vmware-vdiskmanager are both required.")
	} else {
		results[1].Reason = pointer("VMware Workstation was not found. Install it yourself, then refresh detection.")
	}

	return results, nil
}

// Select never replaces an explicitly requested or previously selected provider.
func SelectProvider(requested string, preferred contracts.VmProviderId, available []Hypervisor) (contracts.VmProviderId, error) {
	if requested != "auto" && requested != string(contracts.VmProviderIdHyperV) && requested != string(contracts.VmProviderIdVMware) {
		return "", ErrProvider
	}
	selected := contracts.VmProviderId(requested)
	if requested == "auto" {
		selected = preferred
		if selected == "" {
			for _, provider := range available {
				if provider.Available {
					selected = provider.ID
					break
				}
			}
		}
	}

	if selected != contracts.VmProviderIdHyperV && selected != contracts.VmProviderIdVMware {
		return "", ErrProviderUnavailable
	}
	for _, provider := range available {
		if provider.ID == selected && provider.Available {
			return selected, nil
		}
	}

	return "", ErrProviderUnavailable
}

type ScriptCommand struct {
	Script string
	Args   []string
}

type SetupPlan struct {
	Prepare ScriptCommand
	Create  ScriptCommand
	Stage   contracts.ProvisioningStatus
}

type SetupInput struct {
	DataDir   string
	CPU       int
	MemoryGB  int
	DiskGB    int
	AdminSudo bool
	Tools     *HypervisorTools
}

func (providers *Providers) SetupPlan(id contracts.VmProviderId, input SetupInput) (SetupPlan, error) {
	capabilities, err := providers.Capabilities(id)
	if err != nil || !capabilities.AutomaticSetup || input.DataDir == "" {
		return SetupPlan{}, ErrProviderUnavailable
	}
	base := []string{"-DataDirectory", input.DataDir}
	vmware := id == contracts.VmProviderIdVMware
	if vmware && input.Tools != nil {
		if input.Tools.VMRun == nil || input.Tools.VDiskManager == nil {
			return SetupPlan{}, ErrProviderUnavailable
		}
		base = append(base, "-VmrunPath", *input.Tools.VMRun, "-VdiskmanagerPath", *input.Tools.VDiskManager)
	}
	plan := SetupPlan{
		Prepare: ScriptCommand{Script: "prepare-vm.ps1", Args: append([]string{}, base...)},
		Create:  ScriptCommand{Script: "launch-vm.ps1", Args: append([]string{}, base...)},
		Stage:   contracts.ProvisioningStatusAwaitingAdmin,
	}
	if vmware {
		plan.Prepare.Script = "prepare-vmware.ps1"
		plan.Create.Script = "create-vmware.ps1"
		plan.Stage = contracts.ProvisioningStatusCreating
	}

	if input.AdminSudo {
		plan.Prepare.Args = append(plan.Prepare.Args, "-AdminSudo")
	}
	plan.Create.Args = append(plan.Create.Args, "-Cpu", strconv.Itoa(input.CPU), "-MemoryGB", strconv.Itoa(input.MemoryGB), "-DiskGB", strconv.Itoa(input.DiskGB))
	return plan, nil
}

type LifecycleInput struct {
	ProjectRoot string
	DataDir     string
	Action      string
	Binding     string
	VMID        string
	OperationID string
	ExpiresAt   int64
}

type Command struct {
	Executable string
	Args       []string
}

var operationID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var bindingDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (providers *Providers) LifecycleCommand(id contracts.VmProviderId, input LifecycleInput) (Command, error) {
	capabilities, err := providers.Capabilities(id)
	if err != nil || !capabilities.PowerLifecycle || (input.Action != "suspend" && input.Action != "resume") || !operationID.MatchString(input.OperationID) || !bindingDigest.MatchString(input.Binding) || input.ExpiresAt < 1 {
		return Command{}, ErrProvider
	}
	args := []string{
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", filepath.Join(input.ProjectRoot, "scripts", "vm-lifecycle.ps1"),
		"-Action", input.Action,
		"-DataDirectory", input.DataDir,
		"-ExpectedBinding", input.Binding,
		"-ExpectedOperation", input.OperationID,
		"-ExpectedDeadline", strconv.FormatInt(input.ExpiresAt, 10),
	}
	if input.VMID != "" {
		args = append(args, "-ExpectedVmId", input.VMID)
	}

	return Command{Executable: providers.host.Commands.PowerShell, Args: args}, nil
}
