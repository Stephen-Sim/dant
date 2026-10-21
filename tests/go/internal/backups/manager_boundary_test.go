package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestBackupManagerAutomaticPolicyDoesNotRepeatFreshOrUnavailableWork(t *testing.T) {
	for _, mode := range []string{"manual", "denied", "backoff", "offline", "unsupported", "unprotected", "catalog-failed", "fresh", "due", "connected"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, metadata, changed, now := managerFixture(t)
			var exports atomic.Int32
			manager.options.Transport = &controlledBackupTransport{
				transportFixture: base,
				exportFn: func(ctx context.Context) (ExportSource, error) {
					exports.Add(1)
					source, err := base.Export(ctx)
					source.Metadata.CreatedAt = now.Load()
					return source, err
				},
			}
			manager.connection = base.target.Identity + ":1"
			manager.settings.OnConnect = false
			switch mode {
			case "manual":
				manager.settings.Mode = contracts.BackupModeManual
			case "denied":
				manager.options.Allowed = func() bool { return false }
			case "backoff":
				manager.retryAt = now.Load() + time.Hour.Milliseconds()
			case "offline":
				base.target.Online = false
			case "unsupported":
				base.target.Supported = false
			case "unprotected":
				manager.options.Vault.protection = nil
			case "catalog-failed":
				if err := os.Rename(manager.options.Vault.directory, manager.options.Vault.directory+".retained"); err != nil {
					t.Fatal(err)
				}
			case "fresh", "due":
				metadata.ID = NewID()
				metadata.Source = sourcePrefix(base.target.Identity)
				if err := manager.options.Vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
					t.Fatal(err)
				}
				if mode == "due" {
					now.Add(time.Hour.Milliseconds())
				}
			case "connected":
				manager.connection = ""
				manager.settings.OnConnect = true
			}

			err := manager.Tick(t.Context())
			if mode == "catalog-failed" {
				if !errors.Is(err, ErrInvalid) {
					t.Fatal("invalid inventory was treated as a complete catalog")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			waitManager(t, manager, changed)
			want := int32(0)
			if mode == "due" || mode == "connected" {
				want = 1
				if manager.Phase() != contracts.BackupPhaseIdle {
					t.Fatal("eligible isolated backup did not finish")
				}
				if err := manager.Tick(t.Context()); err != nil {
					t.Fatal(err)
				}
				waitManager(t, manager, changed)
			}
			if exports.Load() != want {
				t.Fatal("automatic policy started or repeated an ineligible export")
			}
		})
	}
}

func TestBackupManagerStatusRetainsLatestSourceAndBackoffDeadline(t *testing.T) {
	manager, transport, metadata, _, now := managerFixture(t)
	metadata.ID = NewID()
	metadata.Source = sourcePrefix(transport.target.Identity)
	metadata.CreatedAt = now.Load() - 1000
	if err := manager.options.Vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
		t.Fatal(err)
	}
	manager.retryAt = now.Load() + 2*time.Hour.Milliseconds()
	status, err := manager.Status(t.Context())
	if err != nil || status.LastBackupAt == nil || *status.LastBackupAt != metadata.CreatedAt || status.NextAt == nil || *status.NextAt != manager.retryAt {
		t.Fatal("status lost the matching source or its bounded retry deadline")
	}
	if err := os.Rename(manager.options.Vault.directory, manager.options.Vault.directory+".retained"); err != nil {
		t.Fatal(err)
	}
	status, err = manager.Status(t.Context())
	if err != nil || status.Backups == nil || len(status.Backups) != 0 || status.LastError == nil || *status.LastError != ErrInvalid.Error() {
		t.Fatal("unavailable catalog was hidden or exposed a null collection")
	}
}

func TestBackupManagerRestoreAdmissionAndReceiptFailuresNeverReachTransport(t *testing.T) {
	for _, mode := range []string{"target", "unavailable", "decrypt", "receipt-directory"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, metadata, changed, _ := managerFixture(t)
			transport := &controlledBackupTransport{transportFixture: base}
			manager.options.Transport = transport
			preview, err := manager.PreviewRestore(t.Context(), metadata.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "target":
				transport.targetFn = func(context.Context, bool) (Target, error) { return Target{}, context.Canceled }
			case "unavailable":
				base.target.Online = false
			case "decrypt":
				manager.options.Vault.protection = failingBackupProtection{unprotect: func(context.Context, []byte) ([]byte, error) {
					return nil, io.ErrUnexpectedEOF
				}}
			case "receipt-directory":
				if err := os.Mkdir(manager.receiptFile, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := manager.Restore(metadata.ID, preview.Confirmation); err != nil {
				t.Fatal(err)
			}
			waitManager(t, manager, changed)
			if base.restoreCalls != 0 || manager.Phase() != contracts.BackupPhaseFailed || manager.Busy() {
				t.Fatal("failed local preparation crossed the remote restore boundary")
			}
			assertVaultPrivateStagesEmpty(t, manager.options.Vault)
		})
	}
}

func TestBackupManagerUnknownReceiptIsReconciledWithoutAnotherRestore(t *testing.T) {
	for _, mode := range []string{"not-confirmed", "rejected-later", "missing", "invalid", "memory-changed"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, metadata, changed, now := managerFixture(t)
			transport := &controlledBackupTransport{transportFixture: base}
			manager.options.Transport = transport
			preview, err := manager.PreviewRestore(t.Context(), metadata.ID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "missing" || mode == "invalid" || mode == "memory-changed" {
				transport.reconcileFn = func(context.Context, string, Target) (bool, error) {
					switch mode {
					case "missing":
						if err := os.Remove(manager.receiptFile); err != nil {
							t.Fatal(err)
						}
					case "invalid":
						if err := os.WriteFile(manager.receiptFile, []byte("{}"), 0600); err != nil {
							t.Fatal(err)
						}
					case "memory-changed":
						manager.mu.Lock()
						manager.receipt = nil
						manager.phase = contracts.BackupPhaseUnknown
						manager.mu.Unlock()
					}
					return true, nil
				}
			}
			if err := manager.Restore(metadata.ID, preview.Confirmation); err != nil {
				t.Fatal(err)
			}
			waitManager(t, manager, changed)
			if manager.Phase() != contracts.BackupPhaseUnknown || !manager.Busy() || base.restoreCalls != 1 {
				t.Fatal("unconfirmed restore lost uncertainty or repeated delivery")
			}
			if mode == "rejected-later" {
				transport.rejectedFn = func(context.Context, string, Target) (bool, error) { return true, nil }
				now.Add(BackupRetryDelay.Milliseconds())
				if err := manager.Tick(t.Context()); err != nil {
					t.Fatal(err)
				}
				if manager.Phase() != contracts.BackupPhaseFailed || manager.lastError == nil || *manager.lastError != ErrRestoreRejected.Error() {
					t.Fatal("independent late rejection did not release the exact receipt")
				}
			} else if mode == "not-confirmed" {
				now.Add(BackupRetryDelay.Milliseconds())
				if err := manager.Tick(t.Context()); err != nil || manager.Phase() != contracts.BackupPhaseUnknown {
					t.Fatal("inconclusive observation authorized replay")
				}
			}
			if base.restoreCalls != 1 {
				t.Fatal("reconciliation resent an external restore")
			}
		})
	}
}

func TestBackupManagerConfigurationFailureKeepsPreviousPreferences(t *testing.T) {
	manager, _, _, _, _ := managerFixture(t)
	before := manager.settings
	if err := os.Mkdir(manager.settingsFile, 0700); err != nil {
		t.Fatal(err)
	}
	if err := manager.Configure(t.Context(), []byte(`{"mode":"manual"}`)); !errors.Is(err, ErrSettings) || manager.settings != before {
		t.Fatal("failed durable save changed the active preferences")
	}
	for _, raw := range []string{`[]`, `{"beforeVmChange":null}`, `{"beforeVmChange":"yes"}`} {
		if _, err := PatchSettings([]byte(raw), before); !errors.Is(err, ErrSettings) {
			t.Fatal("invalid or ambiguous backup preference was accepted")
		}
	}
}

func TestBackupManagerBeforeChangeAndPreviewVersionBoundaries(t *testing.T) {
	for _, mode := range []string{"disabled", "target-error", "no-identity", "catalog-error", "closed"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, _, _, _ := managerFixture(t)
			want := error(nil)
			switch mode {
			case "disabled":
				manager.settings.BeforeVMChange = false
			case "target-error":
				manager.options.Transport = &controlledBackupTransport{targetFn: func(context.Context, bool) (Target, error) { return Target{}, context.Canceled }}
				want = context.Canceled
			case "no-identity":
				base.target.Identity = ""
			case "catalog-error":
				if err := os.Rename(manager.options.Vault.directory, manager.options.Vault.directory+".retained"); err != nil {
					t.Fatal(err)
				}
				want = ErrInvalid
			case "closed":
				manager.Close()
				want = ErrRunning
			}
			if err := manager.BeforeVMChange(t.Context()); !errors.Is(err, want) {
				t.Fatalf("before-change policy returned %v, want %v", err, want)
			}
			if mode == "closed" {
				if err := manager.Tick(t.Context()); err != nil {
					t.Fatal("closed automatic loop accepted work")
				}
				if !errors.Is(manager.assertAvailable(base.target), ErrBusy) {
					t.Fatal("closed manager reported an available write target")
				}
			}
		})
	}
	manager, transport, metadata, _, _ := managerFixture(t)
	transport.target.Version = nil
	preview, err := manager.PreviewRestore(t.Context(), metadata.ID)
	if err != nil || !slices.Contains(preview.Warnings, "service-version-differs") {
		t.Fatal("unknown service version was presented as a confirmed match")
	}
	if safeBackupError(nil) != "" {
		t.Fatal("a successful operation created an error")
	}
}
