package computer

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const VMOperationTimeout = 85 * time.Second
const commandReceiptMaxBytes = 32768
const lifecycleCleanupTimeout = time.Second
const maxGuestAddresses = 16

type CommandRunner func(context.Context, string, []string, io.Reader) ([]byte, error)
type LifecycleOptions struct {
	DataDir     string
	ProjectRoot string
	Host        platform.Host
	Run         CommandRunner
	Now         func() time.Time
	Timeout     time.Duration
	ID          func() string
}

type VMLifecycle struct {
	mu        sync.Mutex
	busy      bool
	options   LifecycleOptions
	providers *Providers
	file      string
}

type lifecycleBinding struct {
	Host     string `json:"host"`
	KeyPath  string `json:"keyPath"`
	Provider string `json:"provider"`
	Name     string `json:"name"`
	VMwareID string `json:"vmwareId"`
	raw      contracts.RawObject
	digest   string
}

type lifecycleReceipt struct {
	Version     int                      `json:"version"`
	Phase       contracts.VmReceiptPhase `json:"phase"`
	Provider    contracts.VmProviderId   `json:"provider"`
	Binding     string                   `json:"binding"`
	VMID        *string                  `json:"vmId"`
	OperationID string                   `json:"operationId,omitempty"`
	ExpiresAt   int64                    `json:"expiresAt,omitempty"`
}

type lifecycleCommandResult struct {
	OK        bool                   `json:"ok"`
	Provider  contracts.VmProviderId `json:"provider"`
	VMID      string                 `json:"vmId"`
	State     contracts.VmPowerState `json:"state"`
	Changed   *bool                  `json:"changed"`
	Addresses []string               `json:"addresses,omitempty"`
}

type SuspendResult struct {
	OK          bool                   `json:"ok"`
	Supported   bool                   `json:"supported"`
	VMSuspended bool                   `json:"vmSuspended"`
	State       contracts.VmPowerState `json:"state,omitempty"`
}

type ResumeResult struct {
	OK      bool                   `json:"ok"`
	Resumed bool                   `json:"resumed"`
	State   contracts.VmPowerState `json:"state,omitempty"`
}

var vmIdentity = regexp.MustCompile(`(?i)^[a-f0-9-]{36}$`)
var managedVMName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`)

func operationUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("host entropy unavailable")
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func NewLifecycle(options LifecycleOptions) (*VMLifecycle, error) {
	if !filepath.IsAbs(options.DataDir) || !filepath.IsAbs(options.ProjectRoot) {
		return nil, lifecycleFailure(LifecycleReasonInvalidIdentity)
	}

	if options.Run == nil {
		options.Run = platform.Run
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.ID == nil {
		options.ID = operationUUID
	}

	if options.Timeout == 0 {
		options.Timeout = VMOperationTimeout
	}

	if options.Timeout <= 0 || options.Timeout > VMOperationTimeout {
		return nil, lifecycleFailure(LifecycleReasonInvalidTimeout)
	}

	return &VMLifecycle{options: options, providers: NewProviders(options.Host, ProviderDetection{}), file: filepath.Join(options.DataDir, "vm-lifecycle.json")}, nil
}

func (lifecycle *VMLifecycle) binding() (*lifecycleBinding, error) {
	raw, err := files.ReadRegular(filepath.Join(lifecycle.options.DataDir, "vm.json"), bindingMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}

	if err != nil {
		return nil, lifecycleFailure(LifecycleReasonInvalidIdentity)
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	object, err := contracts.DecodeObject(raw, bindingMaxBytes)
	if err != nil {
		return nil, lifecycleFailure(LifecycleReasonInvalidIdentity)
	}
	var binding lifecycleBinding
	if json.Unmarshal(raw, &binding) != nil {
		return nil, lifecycleFailure(LifecycleReasonInvalidIdentity)
	}
	sum := sha256.Sum256(raw)
	binding.digest = hex.EncodeToString(sum[:])
	binding.raw = object
	return &binding, nil
}

func (lifecycle *VMLifecycle) managed(binding *lifecycleBinding) contracts.VmProviderId {
	if binding == nil || !filepath.IsAbs(binding.KeyPath) || filepath.Base(binding.KeyPath) != "vm-key" {
		return ""
	}

	if binding.Provider != "" && binding.Provider != string(contracts.VmProviderIdHyperV) && binding.Provider != string(contracts.VmProviderIdVMware) {
		return ""
	}
	base := filepath.Dir(binding.KeyPath)
	if binding.Provider == string(contracts.VmProviderIdVMware) {
		var manifest struct {
			Owner    string `json:"owner"`
			Provider string `json:"provider"`
			Version  int    `json:"version"`
			ID       string `json:"id"`
			VMX      string `json:"vmx"`
			Disk     string `json:"disk"`
			Phase    string `json:"phase"`
		}
		raw, err := files.ReadRegular(filepath.Join(base, "manifest.json"), bindingMaxBytes)
		if err != nil || json.Unmarshal(raw, &manifest) != nil {
			return ""
		}
		vmx := filepath.Join(base, "dant.vmx")
		if manifest.Owner != "dant-vmware-v1" || manifest.Provider != string(contracts.VmProviderIdVMware) || manifest.Version != 1 || manifest.ID != binding.VMwareID || !vmIdentity.MatchString(manifest.ID) || filepath.Clean(manifest.VMX) != vmx || filepath.Clean(manifest.Disk) != filepath.Join(base, "dant.vmdk") {
			return ""
		}
		switch manifest.Phase {
		case "created", "starting", "started", "connected":
		default:
			return ""
		}
		text, err := files.ReadRegular(vmx, privateKeyMaxBytes)
		if err != nil {
			return ""
		}
		annotation := regexp.MustCompile(`(?m)^annotation\s*=\s*"dant-vmware-v1:` + regexp.QuoteMeta(manifest.ID) + `"\s*$`)
		if !annotation.Match(text) {
			return ""
		}
		return contracts.VmProviderIdVMware
	}
	var status struct {
		Stage string `json:"stage"`
		Name  string `json:"name"`
	}
	raw, err := files.ReadRegular(filepath.Join(base, "vm-setup-status.json"), bindingMaxBytes)
	if err != nil || json.Unmarshal(raw, &status) != nil || (status.Stage != "ready" && status.Stage != "guest-installing") || !managedVMName.MatchString(status.Name) || (binding.Name != "" && binding.Name != status.Name) {
		return ""
	}
	disk, err := os.Lstat(filepath.Join(base, "vm", "dant.vhdx"))
	if err != nil || !disk.Mode().IsRegular() {
		return ""
	}

	return contracts.VmProviderIdHyperV
}

func (lifecycle *VMLifecycle) receipt() (*lifecycleReceipt, error) {
	raw, err := files.ReadRegular(lifecycle.file, bindingMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}

	if err != nil {
		return nil, lifecycleFailure(LifecycleReasonInvalidReceipt)
	}
	var receipt lifecycleReceipt
	if json.Unmarshal(raw, &receipt) != nil || receipt.Version != 1 || !receipt.Phase.Valid() || (receipt.Provider != contracts.VmProviderIdHyperV && receipt.Provider != contracts.VmProviderIdVMware) || !bindingDigest.MatchString(receipt.Binding) || (receipt.VMID != nil && !vmIdentity.MatchString(*receipt.VMID)) {
		return nil, lifecycleFailure(LifecycleReasonInvalidReceipt)
	}

	if (receipt.OperationID != "" || receipt.ExpiresAt != 0) && (!operationID.MatchString(receipt.OperationID) || receipt.ExpiresAt <= 0) {
		return nil, lifecycleFailure(LifecycleReasonInvalidReceipt)
	}

	return &receipt, nil
}

func (lifecycle *VMLifecycle) write(ctx context.Context, receipt lifecycleReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return lifecycleFailure(LifecycleReasonInvalidReceipt)
	}

	return files.WriteAtomic(ctx, lifecycle.file, data, 0600)
}

func equalVMID(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func (lifecycle *VMLifecycle) current(receipt lifecycleReceipt) bool {
	value, err := lifecycle.receipt()
	return err == nil && value != nil && value.OperationID == receipt.OperationID && value.ExpiresAt == receipt.ExpiresAt && value.Binding == receipt.Binding && value.Phase == receipt.Phase && value.Provider == receipt.Provider && equalVMID(value.VMID, receipt.VMID)
}

func (lifecycle *VMLifecycle) intent(receipt lifecycleReceipt, phase contracts.VmReceiptPhase) lifecycleReceipt {
	receipt.Phase = phase
	receipt.OperationID = lifecycle.options.ID()
	receipt.ExpiresAt = lifecycle.options.Now().Add(lifecycle.options.Timeout).UnixMilli()
	return receipt
}

func validGuestAddress(value string) bool {
	ip := net.ParseIP(value)
	if ip == nil || ip.To4() == nil {
		return false
	}
	octets := ip.To4()
	return octets[0] > 0 && octets[0] < 224 && octets[0] != 127 && !(octets[0] == 169 && octets[1] == 254)
}

func (lifecycle *VMLifecycle) command(ctx context.Context, action string, binding *lifecycleBinding, receipt lifecycleReceipt) (lifecycleCommandResult, error) {
	vmID := ""
	if receipt.VMID != nil {
		vmID = *receipt.VMID
	}
	command, err := lifecycle.providers.LifecycleCommand(receipt.Provider, LifecycleInput{ProjectRoot: lifecycle.options.ProjectRoot, DataDir: lifecycle.options.DataDir, Action: action, Binding: binding.digest, VMID: vmID, OperationID: receipt.OperationID, ExpiresAt: receipt.ExpiresAt})
	if err != nil {
		return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonUnsupported)
	}
	ctx, cancel := context.WithTimeout(ctx, lifecycle.options.Timeout)
	defer cancel()
	raw, err := lifecycle.options.Run(ctx, command.Executable, command.Args, nil)
	if err != nil || len(raw) > commandReceiptMaxBytes {
		return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
	}
	var result lifecycleCommandResult
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &result) != nil || !result.OK || result.Provider != receipt.Provider || !vmIdentity.MatchString(result.VMID) || (receipt.VMID != nil && !strings.EqualFold(*receipt.VMID, result.VMID)) || !result.State.Valid() || result.Changed == nil || len(result.Addresses) > maxGuestAddresses {
		return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
	}
	seen := make(map[string]struct{}, len(result.Addresses))
	for _, address := range result.Addresses {
		if !validGuestAddress(address) {
			return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
		}
		if _, duplicate := seen[address]; duplicate {
			return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
		}
		seen[address] = struct{}{}
	}
	current, err := lifecycle.binding()
	if err != nil || current == nil || current.digest != binding.digest {
		return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonBindingChanged)
	}

	if !lifecycle.current(receipt) {
		return lifecycleCommandResult{}, lifecycleFailure(LifecycleReasonIntentChanged)
	}

	return result, nil
}

func (lifecycle *VMLifecycle) perform(ctx context.Context, action string, binding *lifecycleBinding, receipt lifecycleReceipt) (lifecycleCommandResult, error) {
	result, err := lifecycle.command(ctx, action, binding, receipt)
	if err == nil {
		return result, nil
	}

	if lifecycle.current(receipt) {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), lifecycleCleanupTimeout)
		defer cancel()
		receipt.OperationID = lifecycle.options.ID()
		receipt.ExpiresAt = 1
		_ = lifecycle.write(cleanup, receipt)
	}

	return lifecycleCommandResult{}, err
}

func (lifecycle *VMLifecycle) enter() error {
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	if lifecycle.busy {
		return lifecycleFailure(LifecycleReasonBusy)
	}
	lifecycle.busy = true
	return nil
}

func (lifecycle *VMLifecycle) leave() {
	lifecycle.mu.Lock()
	lifecycle.busy = false
	lifecycle.mu.Unlock()
}

func (lifecycle *VMLifecycle) Suspend(ctx context.Context) (SuspendResult, error) {
	if err := lifecycle.enter(); err != nil {
		return SuspendResult{}, err
	}
	defer lifecycle.leave()
	binding, err := lifecycle.binding()
	if err != nil {
		return SuspendResult{}, err
	}
	provider := lifecycle.managed(binding)
	if binding == nil || provider == "" || !lifecycle.options.Host.Capabilities.ManagedVM {
		return SuspendResult{OK: true}, nil
	}
	previous, err := lifecycle.receipt()
	if err != nil {
		return SuspendResult{}, err
	}

	if previous != nil && (previous.Binding != binding.digest || previous.Provider != provider) {
		return SuspendResult{}, lifecycleFailure(LifecycleReasonBindingChanged)
	}
	receipt := lifecycleReceipt{Version: 1, Provider: provider, Binding: binding.digest}
	if previous != nil {
		receipt = *previous
	}
	receipt = lifecycle.intent(receipt, contracts.VmReceiptPhaseSuspending)
	if _, err := files.OrdinaryDirectory(lifecycle.options.DataDir, true); err != nil {
		return SuspendResult{}, err
	}

	if err := lifecycle.write(ctx, receipt); err != nil {
		return SuspendResult{}, err
	}
	result, err := lifecycle.perform(ctx, "suspend", binding, receipt)
	if err != nil {
		return SuspendResult{}, err
	}

	if result.State != contracts.VmPowerStateSuspended && result.State != contracts.VmPowerStateOff {
		return SuspendResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
	}

	if *result.Changed || previous != nil {
		receipt.Phase = contracts.VmReceiptPhaseSuspended
		receipt.VMID = &result.VMID
		err = lifecycle.write(ctx, receipt)
	} else {
		err = os.Remove(lifecycle.file)
	}

	if err != nil {
		return SuspendResult{}, err
	}

	return SuspendResult{OK: true, Supported: true, VMSuspended: true, State: result.State}, nil
}

func (lifecycle *VMLifecycle) Resume(ctx context.Context) (ResumeResult, error) {
	return lifecycle.resume(ctx, false)
}

func (lifecycle *VMLifecycle) ResumeForReconnect(ctx context.Context) (ResumeResult, error) {
	return lifecycle.resume(ctx, true)
}

func (lifecycle *VMLifecycle) resume(ctx context.Context, explicit bool) (ResumeResult, error) {
	if err := lifecycle.enter(); err != nil {
		return ResumeResult{}, err
	}
	defer lifecycle.leave()
	previous, err := lifecycle.receipt()
	if err != nil {
		return ResumeResult{}, err
	}

	if previous == nil && !explicit {
		return ResumeResult{OK: true}, nil
	}
	binding, err := lifecycle.binding()
	if err != nil {
		return ResumeResult{}, err
	}
	provider := lifecycle.managed(binding)
	if previous == nil && (binding == nil || provider == "" || !lifecycle.options.Host.Capabilities.ManagedVM) {
		return ResumeResult{OK: true}, nil
	}

	if binding == nil || provider == "" || !lifecycle.options.Host.Capabilities.ManagedVM || (previous != nil && (previous.Binding != binding.digest || previous.Provider != provider)) {
		return ResumeResult{}, lifecycleFailure(LifecycleReasonBindingChanged)
	}
	receipt := lifecycleReceipt{Version: 1, Provider: provider, Binding: binding.digest}
	if previous != nil {
		receipt = *previous
	}
	receipt = lifecycle.intent(receipt, contracts.VmReceiptPhaseResuming)
	if err := lifecycle.write(ctx, receipt); err != nil {
		return ResumeResult{}, err
	}
	result, err := lifecycle.perform(ctx, "resume", binding, receipt)
	if err != nil {
		return ResumeResult{}, err
	}

	if result.State != contracts.VmPowerStateRunning && result.State != contracts.VmPowerStateOff {
		return ResumeResult{}, lifecycleFailure(LifecycleReasonUnconfirmed)
	}

	if !lifecycle.current(receipt) {
		return ResumeResult{}, lifecycleFailure(LifecycleReasonIntentChanged)
	}

	if err := os.Remove(lifecycle.file); err != nil {
		return ResumeResult{}, err
	}

	if provider == contracts.VmProviderIdHyperV && result.State == contracts.VmPowerStateRunning && len(result.Addresses) == 1 && result.Addresses[0] != binding.Host {
		current, err := lifecycle.binding()
		if err != nil || current == nil || current.digest != binding.digest {
			return ResumeResult{}, lifecycleFailure(LifecycleReasonBindingChanged)
		}
		binding.raw["host"], _ = json.Marshal(result.Addresses[0])
		raw, err := json.Marshal(binding.raw)
		if err != nil {
			return ResumeResult{}, lifecycleFailure(LifecycleReasonInvalidIdentity)
		}
		if err := files.WriteAtomic(ctx, filepath.Join(lifecycle.options.DataDir, "vm.json"), raw, 0600); err != nil {
			return ResumeResult{}, err
		}
	}

	return ResumeResult{OK: true, Resumed: *result.Changed, State: result.State}, nil
}
