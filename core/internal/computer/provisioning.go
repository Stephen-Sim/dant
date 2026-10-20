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
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const provisioningInstallTimeout = 45 * time.Minute
const provisioningPollInterval = 750 * time.Millisecond
const provisioningProbeInterval = 15 * time.Second

var ErrProvisioningBusy = errors.New("vm_setup_busy")
var ErrProvisioningFailed = errors.New("vm_setup_failed")

type ProvisioningState struct {
	Status             contracts.ProvisioningStatus `json:"status"`
	Stage              string                       `json:"stage"`
	Provider           *contracts.VmProviderId      `json:"provider"`
	Selected           string                       `json:"selected"`
	AvailableProviders []Hypervisor                 `json:"availableProviders"`
	Error              *string                      `json:"error"`
	StartedAt          *int64                       `json:"startedAt"`
	UpdatedAt          int64                        `json:"updatedAt"`
	Connection         *Binding                     `json:"connection"`
	Log                *string                      `json:"log"`
	Output             string                       `json:"output"`
	Running            bool                         `json:"running"`
}

type ProviderInventory struct {
	Selected           string                  `json:"selected"`
	Provider           *contracts.VmProviderId `json:"provider"`
	AvailableProviders []Hypervisor            `json:"availableProviders"`
}

type ProvisioningOptions struct {
	Context              context.Context
	ProjectRoot, DataDir string
	Host                 platform.Host
	Providers            *Providers
	Run                  func(context.Context, string, []string, io.Reader) ([]byte, error)
	Changed              func()
	Now                  func() time.Time
	InstallTimeout       time.Duration
	ProbeInterval        time.Duration
}

type Provisioning struct {
	mu      sync.Mutex
	options ProvisioningOptions
	ctx     context.Context
	cancel  context.CancelFunc
	state   ProvisioningState
	closed  bool
	wg      sync.WaitGroup
}

func NewProvisioning(options ProvisioningOptions) (*Provisioning, error) {
	if options.Context == nil || !filepath.IsAbs(options.ProjectRoot) || !filepath.IsAbs(options.DataDir) {
		return nil, ErrBinding
	}

	if options.Run == nil {
		options.Run = platform.Run
	}

	if options.Providers == nil {
		options.Providers = NewProviders(options.Host, ProviderDetection{})
	}

	if options.Changed == nil {
		options.Changed = func() {}
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.InstallTimeout <= 0 {
		options.InstallTimeout = provisioningInstallTimeout
	}

	if options.ProbeInterval <= 0 {
		options.ProbeInterval = provisioningProbeInterval
	}
	ctx, cancel := context.WithCancel(options.Context)
	result := &Provisioning{
		options: options,
		ctx:     ctx,
		cancel:  cancel,
		state: ProvisioningState{
			Status:             contracts.ProvisioningStatusIdle,
			Stage:              "idle",
			Selected:           "auto",
			AvailableProviders: []Hypervisor{},
			UpdatedAt:          options.Now().UnixMilli(),
		},
	}
	result.refreshLocked()
	return result, nil
}

func (provisioning *Provisioning) refreshLocked() {
	if binding, err := ReadBinding(provisioning.options.DataDir); err == nil {
		provisioning.state.Connection = &binding
		if binding.Provider.Valid() {
			id := binding.Provider
			provisioning.state.Provider = &id
		}
	}
	name := filepath.Join(provisioning.options.DataDir, "vm-setup-status.json")
	info, err := os.Lstat(name)
	if err != nil || (provisioning.state.StartedAt != nil && info.ModTime().UnixMilli() < *provisioning.state.StartedAt) {
		return
	}
	raw, err := files.ReadRegular(name, bindingMaxBytes)
	if err != nil {
		return
	}
	object, err := contracts.DecodeObject(raw, bindingMaxBytes)
	if err != nil {
		return
	}
	var stage string
	if json.Unmarshal(object["stage"], &stage) != nil || len(stage) > 128 || !printable.MatchString(stage) {
		return
	}
	var id contracts.VmProviderId
	if provisioning.state.Connection == nil && json.Unmarshal(object["provider"], &id) == nil && id != contracts.VmProviderIdSsh {
		provisioning.state.Provider = &id
	}
	var selected string
	if json.Unmarshal(object["selected"], &selected) == nil && (selected == "auto" || selected == string(contracts.VmProviderIdHyperV) || selected == string(contracts.VmProviderIdVMware)) {
		provisioning.state.Selected = selected
	}
	failed := stage == "failed" || strings.HasPrefix(stage, "failed:")
	if provisioning.state.Status == contracts.ProvisioningStatusFailed && !failed && stage != "ready" {
		return
	}

	if provisioning.state.Status == contracts.ProvisioningStatusReady && stage != "ready" {
		return
	}
	provisioning.state.Stage = stage
	switch {
	case failed:
		provisioning.state.Status = contracts.ProvisioningStatusFailed
		message := "VM setup failed. Existing VM files were preserved."
		provisioning.state.Error = &message
	case stage == "ready":
		provisioning.state.Status = contracts.ProvisioningStatusReady
		provisioning.state.Error = nil
	case stage == "guest-installing":
		provisioning.state.Status = contracts.ProvisioningStatusInstalling
	case stage == "awaiting-admin":
		provisioning.state.Status = contracts.ProvisioningStatusAwaitingAdmin
	case stage == "preparing":
		provisioning.state.Status = contracts.ProvisioningStatusPreparing
	default:
		provisioning.state.Status = contracts.ProvisioningStatusCreating
	}
}

func (provisioning *Provisioning) Snapshot() ProvisioningState {
	provisioning.mu.Lock()
	defer provisioning.mu.Unlock()
	provisioning.refreshLocked()
	raw, _ := json.Marshal(provisioning.state)
	var copy ProvisioningState
	_ = json.Unmarshal(raw, &copy)
	return copy
}

func (provisioning *Provisioning) Providers(ctx context.Context) (ProviderInventory, error) {
	available, err := provisioning.options.Providers.Detect(ctx)
	if err != nil {
		return ProviderInventory{}, err
	}
	provisioning.mu.Lock()
	defer provisioning.mu.Unlock()
	provisioning.refreshLocked()
	provisioning.state.AvailableProviders = append([]Hypervisor{}, available[:]...)
	provider := provisioning.state.Provider
	if provider == nil && provisioning.state.Connection == nil {
		for _, item := range available {
			if item.Available {
				id := item.ID
				provider = &id
				break
			}
		}
	}

	return ProviderInventory{Selected: provisioning.state.Selected, Provider: provider, AvailableProviders: append([]Hypervisor{}, available[:]...)}, nil
}

func (provisioning *Provisioning) saveProgress(ctx context.Context, stage string) error {
	provisioning.mu.Lock()
	provider := provisioning.state.Provider
	selected := provisioning.state.Selected
	provisioning.mu.Unlock()
	raw, _ := json.Marshal(struct {
		Provider  *contracts.VmProviderId `json:"provider"`
		Selected  string                  `json:"selected"`
		Stage     string                  `json:"stage"`
		Error     *string                 `json:"error"`
		UpdatedAt string                  `json:"updatedAt"`
	}{provider, selected, stage, nil, provisioning.options.Now().UTC().Format(time.RFC3339Nano)})
	return files.WriteAtomic(ctx, filepath.Join(provisioning.options.DataDir, "vm-setup-status.json"), raw, 0600)
}

func (provisioning *Provisioning) set(status contracts.ProvisioningStatus, stage string) {
	provisioning.mu.Lock()
	provisioning.state.Status = status
	provisioning.state.Stage = stage
	provisioning.state.UpdatedAt = provisioning.options.Now().UnixMilli()
	provisioning.mu.Unlock()
	provisioning.options.Changed()
}

type setupRequest struct {
	CPU       int    `json:"cpu"`
	MemoryGB  int    `json:"memoryGB"`
	DiskGB    int    `json:"diskGB"`
	AdminSudo bool   `json:"adminSudo"`
	Provider  string `json:"provider"`
}

func (provisioning *Provisioning) Start(ctx context.Context, raw []byte) (ProvisioningState, error) {
	object, err := contracts.DecodeObject(raw, bindingMaxBytes)
	if err != nil {
		return ProvisioningState{}, ErrBinding
	}
	for key, value := range object {
		switch key {
		case "cpu", "memoryGB", "diskGB", "adminSudo", "provider":
		default:
			return ProvisioningState{}, ErrBinding
		}
		if string(value) == "null" {
			return ProvisioningState{}, ErrBinding
		}
	}
	request := setupRequest{CPU: 4, MemoryGB: 8, DiskGB: 64, Provider: "auto"}
	if json.Unmarshal(raw, &request) != nil || request.CPU < 1 || request.CPU > 64 || request.MemoryGB < 2 || request.MemoryGB > 128 || request.DiskGB < 32 || request.DiskGB > 2048 {
		return ProvisioningState{}, ErrBinding
	}

	if !provisioning.options.Host.Capabilities.ManagedVM {
		return ProvisioningState{}, ErrProviderUnavailable
	}
	inventory, err := provisioning.Providers(ctx)
	if err != nil {
		return ProvisioningState{}, err
	}
	preferred := contracts.VmProviderId("")
	if inventory.Provider != nil {
		preferred = *inventory.Provider
	}
	selected, err := SelectProvider(request.Provider, preferred, inventory.AvailableProviders)
	if err != nil {
		return ProvisioningState{}, err
	}
	var tools *HypervisorTools
	for _, item := range inventory.AvailableProviders {
		if item.ID == selected {
			tools = item.Tools
		}
	}
	provisioning.mu.Lock()
	if provisioning.closed || provisioning.state.Running {
		provisioning.mu.Unlock()
		return ProvisioningState{}, ErrProvisioningBusy
	}
	provisioning.refreshLocked()
	if provisioning.state.Status == contracts.ProvisioningStatusCreating || provisioning.state.Status == contracts.ProvisioningStatusAwaitingAdmin || provisioning.state.Connection != nil {
		provisioning.mu.Unlock()
		return ProvisioningState{}, ErrProvisioningBusy
	}

	if _, err := os.Lstat(filepath.Join(provisioning.options.DataDir, "vm.json")); !errors.Is(err, os.ErrNotExist) {
		provisioning.mu.Unlock()
		return ProvisioningState{}, ErrProvisioningBusy
	}
	for _, name := range []string{filepath.Join(provisioning.options.DataDir, "vm"), filepath.Join(provisioning.options.DataDir, "vmware", "dant.vmx"), filepath.Join(provisioning.options.DataDir, "vmware", "dant.vmdk")} {
		if info, err := os.Lstat(name); err == nil {
			if !info.IsDir() {
				provisioning.mu.Unlock()
				return ProvisioningState{}, ErrProvisioningBusy
			}
			children, err := os.ReadDir(name)
			if err != nil || len(children) > 0 {
				provisioning.mu.Unlock()
				return ProvisioningState{}, ErrProvisioningBusy
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			provisioning.mu.Unlock()
			return ProvisioningState{}, ErrProvisioningBusy
		}
	}
	started := provisioning.options.Now().UnixMilli()
	provisioning.state.StartedAt = &started
	provisioning.state.Provider = &selected
	provisioning.state.Selected = request.Provider
	provisioning.state.Running = true
	provisioning.state.Error = nil
	provisioning.wg.Add(1)
	provisioning.mu.Unlock()
	if _, err := files.OrdinaryDirectory(provisioning.options.DataDir, true); err != nil {
		provisioning.mu.Lock()
		provisioning.state.Running = false
		provisioning.mu.Unlock()
		provisioning.wg.Done()
		return ProvisioningState{}, ErrBinding
	}

	if err := provisioning.saveProgress(ctx, "preparing"); err != nil {
		provisioning.mu.Lock()
		provisioning.state.Running = false
		provisioning.mu.Unlock()
		provisioning.wg.Done()
		return ProvisioningState{}, err
	}
	provisioning.set(contracts.ProvisioningStatusPreparing, "preparing")
	go provisioning.run(SetupInput{DataDir: provisioning.options.DataDir, CPU: request.CPU, MemoryGB: request.MemoryGB, DiskGB: request.DiskGB, AdminSudo: request.AdminSudo, Tools: tools}, selected, false)
	return provisioning.Snapshot(), nil
}

func (provisioning *Provisioning) execute(ctx context.Context, command ScriptCommand) error {
	switch command.Script {
	case "prepare-vm.ps1", "launch-vm.ps1", "prepare-vmware.ps1", "create-vmware.ps1", "check-vm.ps1":
	default:
		return ErrProvider
	}
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(provisioning.options.ProjectRoot, "scripts", command.Script)}
	args = append(args, command.Args...)
	if _, err := provisioning.options.Run(ctx, provisioning.options.Host.Commands.PowerShell, args, nil); err != nil {
		return ErrProvisioningFailed
	}

	return nil
}

func (provisioning *Provisioning) run(input SetupInput, id contracts.VmProviderId, monitor bool) {
	defer provisioning.wg.Done()
	ctx, cancel := context.WithTimeout(provisioning.ctx, provisioning.options.InstallTimeout)
	defer cancel()
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		ticker := time.NewTicker(provisioningPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				provisioning.mu.Lock()
				provisioning.refreshLocked()
				provisioning.mu.Unlock()
				provisioning.options.Changed()
			}
		}
	}()
	err := func() error {
		if !monitor {
			plan, err := provisioning.options.Providers.SetupPlan(id, input)
			if err != nil {
				return err
			}
			if err := provisioning.execute(ctx, plan.Prepare); err != nil {
				return err
			}
			if err := provisioning.saveProgress(ctx, string(plan.Stage)); err != nil {
				return err
			}
			provisioning.set(plan.Stage, string(plan.Stage))
			if err := provisioning.execute(ctx, plan.Create); err != nil {
				return err
			}
		}
		for {
			state := provisioning.Snapshot()
			if state.Status == contracts.ProvisioningStatusFailed {
				return ErrProvisioningFailed
			}
			if state.Status == contracts.ProvisioningStatusReady {
				return nil
			}
			if state.Connection != nil {
				if err := provisioning.execute(ctx, ScriptCommand{Script: "check-vm.ps1", Args: []string{"-DataDirectory", provisioning.options.DataDir}}); err == nil {
					if err := provisioning.saveProgress(ctx, "ready"); err != nil {
						return err
					}
					provisioning.set(contracts.ProvisioningStatusReady, "ready")
					return nil
				}
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(provisioning.options.ProbeInterval):
			}
		}
	}()
	cancel()
	<-pollDone
	provisioning.mu.Lock()
	provisioning.state.Running = false
	if err != nil && !provisioning.closed {
		provisioning.state.Status = contracts.ProvisioningStatusFailed
		provisioning.state.Stage = "failed:" + provisioning.state.Stage
		message := "VM setup stopped. Existing VM and disk files were preserved."
		provisioning.state.Error = &message
	}
	provisioning.mu.Unlock()
	provisioning.options.Changed()
}

func (provisioning *Provisioning) ResumeMonitoring() ProvisioningState {
	provisioning.mu.Lock()
	provisioning.refreshLocked()
	if provisioning.closed || provisioning.state.Running || !provisioning.options.Host.Capabilities.ManagedVM {
		provisioning.mu.Unlock()
		return provisioning.Snapshot()
	}
	switch provisioning.state.Status {
	case contracts.ProvisioningStatusCreating, contracts.ProvisioningStatusAwaitingAdmin, contracts.ProvisioningStatusInstalling:
	default:
		provisioning.mu.Unlock()
		return provisioning.Snapshot()
	}
	provisioning.state.Running = true
	provisioning.wg.Add(1)
	id := contracts.VmProviderIdHyperV
	if provisioning.state.Provider != nil {
		id = *provisioning.state.Provider
	}
	provisioning.mu.Unlock()
	go provisioning.run(SetupInput{}, id, true)
	return provisioning.Snapshot()
}

func (provisioning *Provisioning) Close() {
	provisioning.mu.Lock()
	provisioning.closed = true
	provisioning.cancel()
	provisioning.mu.Unlock()
	provisioning.wg.Wait()
}
