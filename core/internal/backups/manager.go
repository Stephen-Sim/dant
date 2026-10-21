package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const BackupCheckInterval = 30 * time.Second
const BackupRetryDelay = 5 * time.Minute
const BackupPreviewTTL = 5 * time.Minute
const BackupIOTimeout = 15 * time.Minute

var targetIdentity = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ErrRunning = errors.New("backup_running")
var ErrRestoreUnconfirmed = errors.New("backup_restore_unconfirmed")
var ErrRestoreRejected = errors.New("backup_restore_rejected")
var ErrPreviewExpired = errors.New("backup_preview_expired")
var ErrConnectionChanged = errors.New("backup_connection_changed")
var ErrBeforeVMChange = errors.New("backup_before_vm_change_required")
var ErrSettings = errors.New("backup_settings_invalid")
var ErrOffline = errors.New("backup_offline")
var ErrServiceUpdate = errors.New("backup_service_update_required")

type Settings struct {
	Mode            contracts.BackupMode `json:"mode"`
	IntervalMinutes int                  `json:"intervalMinutes"`
	OnConnect       bool                 `json:"onConnect"`
	BeforeVMChange  bool                 `json:"beforeVmChange"`
	RetainCount     int                  `json:"retainCount"`
}

func DefaultSettings() Settings {
	return Settings{Mode: contracts.BackupModeAutomatic, IntervalMinutes: 60, OnConnect: true, BeforeVMChange: true, RetainCount: 10}
}

func PatchSettings(raw []byte, base Settings) (Settings, error) {
	object, err := contracts.DecodeObject(raw, bindingSettingsMaxBytes)
	if err != nil {
		return Settings{}, ErrSettings
	}
	for key, value := range object {
		var err error
		switch key {
		case "mode":
			err = json.Unmarshal(value, &base.Mode)
		case "intervalMinutes":
			err = json.Unmarshal(value, &base.IntervalMinutes)
		case "onConnect":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return Settings{}, ErrSettings
			}
			err = json.Unmarshal(value, &base.OnConnect)
		case "beforeVmChange":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return Settings{}, ErrSettings
			}
			err = json.Unmarshal(value, &base.BeforeVMChange)
		case "retainCount":
			err = json.Unmarshal(value, &base.RetainCount)
		default:
			return Settings{}, ErrSettings
		}
		if err != nil {
			return Settings{}, ErrSettings
		}
	}

	if !base.Mode.Valid() || base.IntervalMinutes < 15 || base.IntervalMinutes > 10080 || base.RetainCount < 1 || base.RetainCount > 100 {
		return Settings{}, ErrSettings
	}

	return base, nil
}

const bindingSettingsMaxBytes = 64 * 1024

type Target struct {
	Identity   string
	Generation uint64
	Online     bool
	Supported  bool
	Empty      bool
	Version    *string
}

type ExportSource struct {
	Metadata Metadata
	Stream   io.ReadCloser
}

type BackupTransport interface {
	Target(context.Context, bool) (Target, error)
	Export(context.Context) (ExportSource, error)
	Restore(context.Context, io.Reader, string, Target) error
	Reconcile(context.Context, string, Target) (bool, error)
	Rejected(context.Context, string, Target) (bool, error)
}

type PreviewTarget struct {
	ID    string `json:"id"`
	Empty bool   `json:"empty"`
}

type Preview struct {
	Backup       Metadata      `json:"backup"`
	Confirmation string        `json:"confirmation"`
	ExpiresAt    int64         `json:"expiresAt"`
	Target       PreviewTarget `json:"target"`
	Warnings     []string      `json:"warnings"`
}

type previewRecord struct {
	value  Preview
	target Target
}

type restoreReceipt struct {
	BackupID  string `json:"backupId"`
	RestoreID string `json:"restoreId"`
	Target    string `json:"target"`
	CreatedAt int64  `json:"createdAt"`
}

type Availability struct {
	Online    bool   `json:"online"`
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

type Status struct {
	Settings       Settings              `json:"settings"`
	Availability   Availability          `json:"availability"`
	Backups        []Metadata            `json:"backups"`
	Phase          contracts.BackupPhase `json:"phase"`
	LastBackupAt   *int64                `json:"lastBackupAt"`
	LastError      *string               `json:"lastError"`
	NextAt         *int64                `json:"nextAt"`
	LastRestoredID *string               `json:"lastRestoredId"`
}

type ManagerOptions struct {
	Context   context.Context
	DataDir   string
	Vault     *Vault
	Transport BackupTransport
	Allowed   func() bool
	Changed   func()
	Now       func() time.Time
	Automatic bool
}

type Manager struct {
	mu             sync.Mutex
	options        ManagerOptions
	settings       Settings
	phase          contracts.BackupPhase
	lastError      *string
	lastRestoredID *string
	receipt        *restoreReceipt
	preview        *previewRecord
	pending        bool
	closed         bool
	retryAt        int64
	scheduleSince  int64
	connection     string
	connectedDue   bool
	settingsFile   string
	receiptFile    string
	ctx            context.Context
	cancel         context.CancelFunc
	wake           chan struct{}
	wg             sync.WaitGroup
}

func errorString(value string) *string { return &value }
func NewManager(options ManagerOptions) (*Manager, error) {
	if !filepath.IsAbs(options.DataDir) || options.Vault == nil || options.Transport == nil || options.Context == nil {
		return nil, ErrInvalid
	}

	if options.Allowed == nil {
		options.Allowed = func() bool { return true }
	}

	if options.Changed == nil {
		options.Changed = func() {}
	}

	if options.Now == nil {
		options.Now = time.Now
	}
	ctx, cancel := context.WithCancel(options.Context)
	manager := &Manager{
		options:       options,
		settings:      DefaultSettings(),
		phase:         contracts.BackupPhaseIdle,
		settingsFile:  filepath.Join(options.DataDir, "backup-settings.json"),
		receiptFile:   filepath.Join(options.DataDir, "backup-restore.json"),
		ctx:           ctx,
		cancel:        cancel,
		wake:          make(chan struct{}, 1),
		scheduleSince: options.Now().UnixMilli(),
	}
	if raw, err := files.ReadRegular(manager.settingsFile, bindingSettingsMaxBytes); err == nil {
		if settings, err := PatchSettings(raw, DefaultSettings()); err == nil {
			manager.settings = settings
		} else {
			manager.settings.Mode = contracts.BackupModeManual
			manager.lastError = errorString(ErrSettings.Error())
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		manager.settings.Mode = contracts.BackupModeManual
		manager.lastError = errorString(ErrSettings.Error())
	}

	if raw, err := files.ReadRegular(manager.receiptFile, bindingSettingsMaxBytes); err == nil {
		var receipt restoreReceipt
		if json.Unmarshal(raw, &receipt) == nil && backupID.MatchString(receipt.BackupID) && backupID.MatchString(receipt.RestoreID) && targetIdentity.MatchString(receipt.Target) && receipt.CreatedAt > 0 {
			manager.receipt = &receipt
		}
		manager.phase = contracts.BackupPhaseUnknown
		manager.lastError = errorString(ErrRestoreUnconfirmed.Error())
	} else if !errors.Is(err, os.ErrNotExist) {
		manager.phase = contracts.BackupPhaseUnknown
		manager.lastError = errorString(ErrRestoreUnconfirmed.Error())
	}

	if options.Automatic {
		manager.wg.Add(1)
		go manager.automatic()
	}

	return manager, nil
}

func (manager *Manager) notify() {
	manager.options.Changed()
	select {
	case manager.wake <- struct{}{}:
	default:
	}
}

func (manager *Manager) Busy() bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.pending || manager.phase == contracts.BackupPhaseUnknown
}

func (manager *Manager) Phase() contracts.BackupPhase {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.phase
}

func (manager *Manager) Configure(ctx context.Context, raw []byte) error {
	manager.mu.Lock()
	if manager.closed || manager.pending {
		manager.mu.Unlock()
		return ErrRunning
	}
	next, err := PatchSettings(raw, manager.settings)
	if err != nil {
		manager.mu.Unlock()
		return err
	}
	bytes, err := json.Marshal(next)
	if err != nil {
		manager.mu.Unlock()
		return ErrSettings
	}

	if err := files.WriteAtomic(ctx, manager.settingsFile, bytes, 0600); err != nil {
		manager.mu.Unlock()
		return ErrSettings
	}
	manager.settings = next
	manager.preview = nil
	manager.retryAt = 0
	manager.scheduleSince = manager.options.Now().UnixMilli()
	manager.mu.Unlock()
	manager.notify()
	return nil
}

func sameTarget(left, right Target) bool {
	return left.Identity == right.Identity && left.Generation == right.Generation && right.Online
}

func (manager *Manager) assertAvailable(target Target) error {
	manager.mu.Lock()
	closed := manager.closed
	manager.mu.Unlock()
	if closed || !manager.options.Allowed() {
		return ErrBusy
	}

	if !target.Online {
		return ErrOffline
	}

	if !target.Supported {
		return ErrServiceUpdate
	}

	if !manager.options.Vault.Protected() {
		return ErrProtectionUnavailable
	}

	if !targetIdentity.MatchString(target.Identity) {
		return ErrConnectionChanged
	}

	return nil
}

func sourcePrefix(identity string) string {
	if len(identity) < 12 {
		return ""
	}

	return identity[:12]
}

func latestFor(metadata []Metadata, target Target) *Metadata {
	for _, backup := range metadata {
		if backup.Source == sourcePrefix(target.Identity) {
			copy := backup
			return &copy
		}
	}

	return nil
}

func (manager *Manager) Status(ctx context.Context) (Status, error) {
	target, err := manager.options.Transport.Target(ctx, false)
	if err != nil {
		return Status{}, err
	}
	backups, invalid, listErr := manager.options.Vault.List()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if listErr != nil || invalid > 0 {
		if manager.lastError == nil {
			manager.lastError = errorString(ErrInvalid.Error())
		}
	}

	if backups == nil {
		backups = []Metadata{}
	}
	availability := Availability{Online: target.Online, Supported: target.Supported && manager.options.Vault.Protected()}
	if !manager.options.Vault.Protected() {
		availability.Reason = ErrProtectionUnavailable.Error()
	} else if !target.Online {
		availability.Reason = ErrOffline.Error()
	} else if !target.Supported {
		availability.Reason = ErrServiceUpdate.Error()
	}
	status := Status{Settings: manager.settings, Availability: availability, Backups: backups, Phase: manager.phase, LastError: manager.lastError, LastRestoredID: manager.lastRestoredID}
	latest := latestFor(backups, target)
	at := manager.scheduleSince
	if latest != nil {
		value := latest.CreatedAt
		status.LastBackupAt = &value
		at = value
	}

	if manager.settings.Mode == contracts.BackupModeAutomatic {
		next := at + int64(manager.settings.IntervalMinutes)*60000
		if next < manager.retryAt {
			next = manager.retryAt
		}
		status.NextAt = &next
	}

	return status, nil
}

func safeBackupError(err error) string {
	if err == nil {
		return ""
	}
	code := err.Error()
	switch code {
	case "backup_busy", "backup_source_changed", "backup_protection_unavailable", "backup_service_update_required", "backup_offline", "backup_failed", "backup_restore_unconfirmed", "backup_restore_rejected", "backup_invalid", "backup_passphrase_invalid", "backup_before_vm_change_required", "backup_running", "backup_settings_invalid", "backup_size_limit", "backup_connection_changed", "backup_preview_expired", "backup_catalog_limit", "backup_exists":
		return code
	}

	return "backup_failed"
}

func (manager *Manager) start(parent context.Context, phase contracts.BackupPhase, operation func(context.Context) error) (<-chan error, error) {
	if !manager.options.Allowed() {
		return nil, ErrBusy
	}
	manager.mu.Lock()
	if manager.closed || manager.pending || manager.phase == contracts.BackupPhaseUnknown {
		unknown := manager.phase == contracts.BackupPhaseUnknown
		manager.mu.Unlock()
		if unknown {
			return nil, ErrRestoreUnconfirmed
		}
		return nil, ErrRunning
	}
	manager.pending = true
	manager.phase = phase
	manager.lastError = nil
	manager.preview = nil
	manager.wg.Add(1)
	manager.mu.Unlock()
	manager.notify()
	done := make(chan error, 1)
	go func() {
		defer manager.wg.Done()
		ctx, cancel := context.WithTimeout(manager.ctx, BackupIOTimeout)
		stop := context.AfterFunc(parent, cancel)
		err := operation(ctx)
		stop()
		cancel()
		manager.mu.Lock()
		manager.pending = false
		if err != nil {
			if manager.receipt != nil || manager.phase == contracts.BackupPhaseUnknown {
				manager.phase = contracts.BackupPhaseUnknown
				manager.lastError = errorString(ErrRestoreUnconfirmed.Error())
			} else {
				manager.phase = contracts.BackupPhaseFailed
				manager.lastError = errorString(safeBackupError(err))
			}
			manager.retryAt = manager.options.Now().Add(BackupRetryDelay).UnixMilli()
		} else {
			if manager.lastError == nil || *manager.lastError != ErrRestoreRejected.Error() {
				manager.phase = contracts.BackupPhaseIdle
				manager.lastError = nil
			}
			manager.retryAt = 0
		}
		manager.mu.Unlock()
		done <- err
		close(done)
		manager.notify()
	}()
	return done, nil
}

func (manager *Manager) Run() error {
	_, err := manager.start(manager.ctx, contracts.BackupPhaseBackingUp, func(ctx context.Context) error {
		target, err := manager.options.Transport.Target(ctx, true)
		if err != nil {
			return err
		}
		if err := manager.assertAvailable(target); err != nil {
			return err
		}
		source, err := manager.options.Transport.Export(ctx)
		if err != nil {
			return err
		}
		defer source.Stream.Close()
		current, err := manager.options.Transport.Target(ctx, false)
		if err != nil || !sameTarget(target, current) {
			return ErrConnectionChanged
		}
		metadata := source.Metadata
		metadata.ID = NewID()
		metadata.Source = sourcePrefix(target.Identity)
		if err := manager.options.Vault.Save(ctx, source.Stream, metadata); err != nil {
			return err
		}
		manager.mu.Lock()
		retain := manager.settings.RetainCount
		manager.connectedDue = false
		manager.mu.Unlock()
		return manager.options.Vault.Retain(ctx, retain)
	})
	return err
}

func (manager *Manager) PreviewRestore(ctx context.Context, id string) (Preview, error) {
	if manager.Busy() {
		return Preview{}, ErrRunning
	}
	target, err := manager.options.Transport.Target(ctx, true)
	if err != nil {
		return Preview{}, err
	}

	if err := manager.assertAvailable(target); err != nil {
		return Preview{}, err
	}
	header, err := manager.options.Vault.ReadHeader(id)
	if err != nil {
		return Preview{}, err
	}
	warnings := []string{}
	if !target.Empty {
		warnings = append(warnings, "replaces-current-data")
	}

	if header.Metadata.Source != sourcePrefix(target.Identity) {
		warnings = append(warnings, "different-computer")
	}

	if target.Version == nil || header.Metadata.AppVersion != *target.Version {
		warnings = append(warnings, "service-version-differs")
	}
	warnings = append(warnings, "tasks-remain-paused", "sign-in-required")
	preview := Preview{Backup: header.Metadata, Confirmation: NewID(), ExpiresAt: manager.options.Now().Add(BackupPreviewTTL).UnixMilli(), Target: PreviewTarget{ID: sourcePrefix(target.Identity), Empty: target.Empty}, Warnings: warnings}
	manager.mu.Lock()
	manager.preview = &previewRecord{value: preview, target: target}
	manager.mu.Unlock()
	return preview, nil
}

func (manager *Manager) finishRestore(receipt restoreReceipt, rejected bool) error {
	raw, err := files.ReadRegular(manager.receiptFile, bindingSettingsMaxBytes)
	if err != nil {
		return ErrRestoreUnconfirmed
	}
	var disk restoreReceipt
	if json.Unmarshal(raw, &disk) != nil || disk.RestoreID != receipt.RestoreID || disk.Target != receipt.Target {
		return ErrRestoreUnconfirmed
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.receipt == nil || manager.receipt.RestoreID != receipt.RestoreID {
		return ErrRestoreUnconfirmed
	}

	if err := os.Remove(manager.receiptFile); err != nil {
		return ErrRestoreUnconfirmed
	}
	manager.receipt = nil
	if rejected {
		manager.phase = contracts.BackupPhaseFailed
		manager.lastError = errorString(ErrRestoreRejected.Error())
	} else {
		manager.lastRestoredID = errorString(receipt.BackupID)
		manager.phase = contracts.BackupPhaseIdle
		manager.lastError = nil
	}

	return nil
}

func (manager *Manager) Restore(id, confirmation string) error {
	manager.mu.Lock()
	preview := manager.preview
	manager.preview = nil
	manager.mu.Unlock()
	if preview == nil || preview.value.Backup.ID != id || preview.value.Confirmation != confirmation || preview.value.ExpiresAt <= manager.options.Now().UnixMilli() {
		return ErrPreviewExpired
	}
	_, err := manager.start(manager.ctx, contracts.BackupPhaseRestoring, func(ctx context.Context) error {
		target, err := manager.options.Transport.Target(ctx, true)
		if err != nil {
			return err
		}
		if err := manager.assertAvailable(target); err != nil {
			return err
		}
		if !sameTarget(preview.target, target) {
			return ErrConnectionChanged
		}
		opened, err := manager.options.Vault.Open(ctx, id)
		if err != nil {
			return err
		}
		defer opened.Reader.Close()
		receipt := restoreReceipt{BackupID: id, RestoreID: NewID(), Target: target.Identity, CreatedAt: manager.options.Now().UnixMilli()}
		raw, _ := json.Marshal(receipt)
		if err := files.WriteAtomic(ctx, manager.receiptFile, raw, 0600); err != nil {
			return err
		}
		manager.mu.Lock()
		manager.receipt = &receipt
		manager.mu.Unlock()
		if err := manager.options.Transport.Restore(ctx, opened.Reader, receipt.RestoreID, target); err != nil {
			if rejected, _ := manager.options.Transport.Rejected(ctx, receipt.RestoreID, target); rejected {
				return manager.finishRestore(receipt, true)
			}
			return err
		}
		if confirmed, _ := manager.options.Transport.Reconcile(ctx, receipt.RestoreID, target); confirmed {
			return manager.finishRestore(receipt, false)
		}
		if rejected, _ := manager.options.Transport.Rejected(ctx, receipt.RestoreID, target); rejected {
			return manager.finishRestore(receipt, true)
		}
		return ErrRestoreUnconfirmed
	})
	return err
}

func (manager *Manager) BeforeVMChange(ctx context.Context) error {
	manager.mu.Lock()
	settings := manager.settings
	manager.mu.Unlock()
	if settings.Mode != contracts.BackupModeAutomatic || !settings.BeforeVMChange {
		return nil
	}
	target, err := manager.options.Transport.Target(ctx, false)
	if err != nil {
		return err
	}

	if !targetIdentity.MatchString(target.Identity) {
		return nil
	}
	metadata, _, err := manager.options.Vault.List()
	if err != nil {
		return err
	}
	latest := latestFor(metadata, target)
	if latest != nil && manager.options.Now().UnixMilli()-latest.CreatedAt < BackupPreviewTTL.Milliseconds() && !manager.Busy() {
		return nil
	}

	if !manager.Busy() {
		if err := manager.Run(); err != nil {
			return err
		}
	}

	return ErrBeforeVMChange
}

func (manager *Manager) ExportPortable(ctx context.Context, id, passphrase string, output io.Writer) error {
	done, err := manager.start(ctx, contracts.BackupPhaseBackingUp, func(ctx context.Context) error {
		_, err := NewPortable(manager.options.Vault).Export(ctx, id, passphrase, output)
		return err
	})
	if err != nil {
		return err
	}

	return <-done
}

func (manager *Manager) ImportPortable(ctx context.Context, input io.Reader, passphrase string) (Metadata, error) {
	var result Metadata
	done, err := manager.start(ctx, contracts.BackupPhaseBackingUp, func(ctx context.Context) error {
		var err error
		result, err = NewPortable(manager.options.Vault).Import(ctx, input, passphrase)
		return err
	})
	if err != nil {
		return Metadata{}, err
	}

	if err := <-done; err != nil {
		return Metadata{}, err
	}

	return result, nil
}

func (manager *Manager) Tick(ctx context.Context) error {
	manager.mu.Lock()
	if manager.closed || manager.pending {
		manager.mu.Unlock()
		return nil
	}
	manager.mu.Unlock()
	target, err := manager.options.Transport.Target(ctx, false)
	if err != nil {
		return err
	}
	connection := ""
	if target.Online {
		connection = target.Identity + ":" + strconv.FormatUint(target.Generation, 10)
	}
	manager.mu.Lock()
	if connection != manager.connection {
		manager.connection = connection
		manager.connectedDue = connection != ""
		manager.scheduleSince = manager.options.Now().UnixMilli()
	}
	phase := manager.phase
	retry := manager.retryAt
	settings := manager.settings
	connectedDue := manager.connectedDue
	since := manager.scheduleSince
	var receipt *restoreReceipt
	if manager.receipt != nil {
		copy := *manager.receipt
		receipt = &copy
	}
	manager.mu.Unlock()
	if phase == contracts.BackupPhaseUnknown {
		if receipt != nil && receipt.Target == target.Identity && manager.options.Now().UnixMilli() >= retry {
			manager.mu.Lock()
			manager.retryAt = manager.options.Now().Add(BackupRetryDelay).UnixMilli()
			manager.mu.Unlock()
			if confirmed, _ := manager.options.Transport.Reconcile(ctx, receipt.RestoreID, target); confirmed {
				return manager.finishRestore(*receipt, false)
			}
			if rejected, _ := manager.options.Transport.Rejected(ctx, receipt.RestoreID, target); rejected {
				return manager.finishRestore(*receipt, true)
			}
		}
		return nil
	}

	if settings.Mode != contracts.BackupModeAutomatic || !manager.options.Allowed() || manager.options.Now().UnixMilli() < retry || !target.Online || !target.Supported || !manager.options.Vault.Protected() {
		return nil
	}
	metadata, _, err := manager.options.Vault.List()
	if err != nil {
		return err
	}
	latest := latestFor(metadata, target)
	at := since
	if latest != nil {
		at = latest.CreatedAt
	}
	due := manager.options.Now().UnixMilli()-at >= int64(settings.IntervalMinutes)*60000
	connected := connectedDue && settings.OnConnect && (latest == nil || manager.options.Now().UnixMilli()-latest.CreatedAt >= BackupPreviewTTL.Milliseconds())
	if due || connected {
		return manager.Run()
	}

	return nil
}

func (manager *Manager) automatic() {
	defer manager.wg.Done()
	timer := time.NewTimer(BackupCheckInterval)
	defer timer.Stop()
	for {
		select {
		case <-manager.ctx.Done():
			return
		case <-manager.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(BackupCheckInterval)
		case <-timer.C:
			if err := manager.Tick(manager.ctx); err != nil {
				manager.mu.Lock()
				manager.retryAt = manager.options.Now().Add(BackupRetryDelay).UnixMilli()
				manager.mu.Unlock()
			}
			timer.Reset(BackupCheckInterval)
		}
	}
}

func (manager *Manager) Changed() { manager.notify() }
func (manager *Manager) Close() {
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		manager.wg.Wait()
		return
	}
	manager.closed = true
	manager.preview = nil
	manager.cancel()
	manager.mu.Unlock()
	manager.wg.Wait()
}
