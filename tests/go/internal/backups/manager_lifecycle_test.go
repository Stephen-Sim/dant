package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controlledBackupTransport struct {
	*transportFixture
	targetFn    func(context.Context, bool) (Target, error)
	exportFn    func(context.Context) (ExportSource, error)
	restoreFn   func(context.Context, io.Reader, string, Target) error
	reconcileFn func(context.Context, string, Target) (bool, error)
	rejectedFn  func(context.Context, string, Target) (bool, error)
}

func (transport *controlledBackupTransport) Target(ctx context.Context, refresh bool) (Target, error) {
	if transport.targetFn != nil {
		return transport.targetFn(ctx, refresh)
	}
	return transport.transportFixture.Target(ctx, refresh)
}
func (transport *controlledBackupTransport) Export(ctx context.Context) (ExportSource, error) {
	if transport.exportFn != nil {
		return transport.exportFn(ctx)
	}
	return transport.transportFixture.Export(ctx)
}
func (transport *controlledBackupTransport) Restore(ctx context.Context, reader io.Reader, id string, target Target) error {
	if transport.restoreFn != nil {
		return transport.restoreFn(ctx, reader, id, target)
	}
	return transport.transportFixture.Restore(ctx, reader, id, target)
}
func (transport *controlledBackupTransport) Reconcile(ctx context.Context, id string, target Target) (bool, error) {
	if transport.reconcileFn != nil {
		return transport.reconcileFn(ctx, id, target)
	}
	return transport.transportFixture.Reconcile(ctx, id, target)
}
func (transport *controlledBackupTransport) Rejected(ctx context.Context, id string, target Target) (bool, error) {
	if transport.rejectedFn != nil {
		return transport.rejectedFn(ctx, id, target)
	}
	return transport.transportFixture.Rejected(ctx, id, target)
}

func TestBackupManagerRejectsInvalidConstructionAndUnsafePersistedSettings(t *testing.T) {
	if _, err := NewManager(ManagerOptions{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid construction accepted")
	}
	for _, mode := range []string{"settings-malformed", "settings-directory", "receipt-malformed", "receipt-directory"} {
		t.Run(mode, func(t *testing.T) {
			manager, _, _, _, _ := managerFixture(t)
			manager.Close()
			file := manager.settingsFile
			if strings.HasPrefix(mode, "receipt") {
				file = manager.receiptFile
			}
			if strings.HasSuffix(mode, "directory") {
				if err := os.Mkdir(file, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(file, []byte(`{"mode":"future","private":"must not appear in status"}`), 0600); err != nil {
				t.Fatal(err)
			}
			restarted, err := NewManager(manager.options)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			status, err := restarted.Status(t.Context())
			if err != nil || status.LastError == nil || strings.Contains(*status.LastError, "private") {
				t.Fatal("invalid disk state was hidden or leaked")
			}
			if strings.HasPrefix(mode, "receipt") {
				if status.Phase != contracts.BackupPhaseUnknown || !errors.Is(restarted.Run(), ErrRestoreUnconfirmed) {
					t.Fatal("invalid durable receipt became safe replay")
				}
			} else if status.Settings.Mode != contracts.BackupModeManual {
				t.Fatal("unsafe automatic preferences remained enabled")
			}
		})
	}
}

func TestBackupManagerAvailabilityAndFailuresRemainBounded(t *testing.T) {
	for _, mode := range []string{"offline", "unsupported", "identity", "protection", "target", "export", "changed", "catalog"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, _, changed, _ := managerFixture(t)
			transport := &controlledBackupTransport{transportFixture: base}
			manager.options.Transport = transport
			switch mode {
			case "offline":
				base.target.Online = false
			case "unsupported":
				base.target.Supported = false
			case "identity":
				base.target.Identity = "bad"
			case "protection":
				manager.options.Vault.protection = nil
			case "target":
				transport.targetFn = func(context.Context, bool) (Target, error) { return Target{}, context.Canceled }
			case "export":
				transport.exportFn = func(context.Context) (ExportSource, error) { return ExportSource{}, errors.New("private payload") }
			case "changed":
				transport.exportFn = func(context.Context) (ExportSource, error) {
					base.target.Generation++
					return ExportSource{Metadata: base.source, Stream: io.NopCloser(strings.NewReader("archive"))}, nil
				}
			case "catalog":
				if err := os.WriteFile(filepath.Join(manager.options.Vault.directory, NewID()+".dantbak"), []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			status, err := manager.Status(t.Context())
			if mode == "target" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal("target observation error ignored")
				}
			} else if err != nil || (mode == "catalog" && status.LastError == nil) {
				t.Fatal("unavailable/corrupt catalog status hidden")
			}
			if mode == "catalog" {
				return
			}
			if err := manager.Run(); err != nil {
				t.Fatal(err)
			}
			waitManager(t, manager, changed)
			status, _ = manager.Status(t.Context())
			if manager.Phase() != contracts.BackupPhaseFailed || manager.lastError == nil || strings.Contains(*manager.lastError, "payload") {
				t.Fatal("failed backup reported success or exposed raw error")
			}
			if _, err := manager.PreviewRestore(t.Context(), NewID()); err == nil {
				t.Fatal("unavailable/missing preview accepted")
			}
		})
	}
}

func TestBackupManagerCancellationJoinsOwnedWorkAndRejectsConcurrentActions(t *testing.T) {
	manager, base, metadata, changed, _ := managerFixture(t)
	entered := make(chan struct{})
	manager.options.Transport = &controlledBackupTransport{transportFixture: base, exportFn: func(ctx context.Context) (ExportSource, error) {
		close(entered)
		<-ctx.Done()
		return ExportSource{}, ctx.Err()
	}}
	if err := manager.Run(); err != nil {
		t.Fatal(err)
	}
	<-entered
	if !manager.Busy() || !errors.Is(manager.Run(), ErrRunning) {
		t.Fatal("concurrent backup crossed single-flight boundary")
	}
	if _, err := manager.PreviewRestore(t.Context(), metadata.ID); !errors.Is(err, ErrRunning) {
		t.Fatal("preview admitted during live snapshot")
	}
	if err := manager.Configure(t.Context(), []byte(`{"mode":"manual"}`)); !errors.Is(err, ErrRunning) {
		t.Fatal("configuration raced active capture")
	}
	manager.Close()
	waitManager(t, manager, changed)
	if manager.Busy() || !errors.Is(manager.Run(), ErrRunning) || !errors.Is(manager.Configure(t.Context(), []byte(`{}`)), ErrRunning) {
		t.Fatal("closed manager retained work or accepted new action")
	}
}

func TestBackupManagerRestoreExpiryRejectionAndReceiptChanges(t *testing.T) {
	for _, mode := range []string{"expired", "wrong-confirmation", "rejected-error", "rejected-check", "receipt-changed"} {
		t.Run(mode, func(t *testing.T) {
			manager, base, metadata, changed, now := managerFixture(t)
			transport := &controlledBackupTransport{transportFixture: base}
			manager.options.Transport = transport
			preview, err := manager.PreviewRestore(t.Context(), metadata.ID)
			if err != nil {
				t.Fatal(err)
			}
			confirmation := preview.Confirmation
			switch mode {
			case "expired":
				now.Add(BackupPreviewTTL.Milliseconds())
			case "wrong-confirmation":
				confirmation = NewID()
			case "rejected-error", "rejected-check":
				base.failRestore = mode == "rejected-error"
				transport.rejectedFn = func(context.Context, string, Target) (bool, error) { return true, nil }
			case "receipt-changed":
				transport.restoreFn = func(context.Context, io.Reader, string, Target) error {
					return os.WriteFile(manager.receiptFile, []byte(`{"restoreId":"different","target":"different"}`), 0600)
				}
				transport.reconcileFn = func(context.Context, string, Target) (bool, error) { return true, nil }
			}
			err = manager.Restore(metadata.ID, confirmation)
			if mode == "expired" || mode == "wrong-confirmation" {
				if !errors.Is(err, ErrPreviewExpired) || !errors.Is(manager.Restore(metadata.ID, preview.Confirmation), ErrPreviewExpired) {
					t.Fatal("expired/consumed confirmation remained reusable")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			waitManager(t, manager, changed)
			if mode == "receipt-changed" {
				if manager.Phase() != contracts.BackupPhaseUnknown {
					t.Fatal("changed disk receipt cleared unknown outcome")
				}
			} else if manager.Phase() != contracts.BackupPhaseFailed || manager.lastError == nil || *manager.lastError != ErrRestoreRejected.Error() {
				t.Fatal("independent rejection was not retained as rejected")
			}
		})
	}
}

func TestBackupManagerPortablePublicRoundTripAndAdmission(t *testing.T) {
	manager, _, metadata, _, _ := managerFixture(t)
	metadata.ID = NewID()
	metadata.CreatedAt = 1000
	if err := manager.options.Vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := manager.ExportPortable(t.Context(), metadata.ID, "fixture portable passphrase", &output); err != nil {
		t.Fatal(err)
	}
	destination, _, _, _, _ := managerFixture(t)
	imported, err := destination.ImportPortable(t.Context(), bytes.NewReader(output.Bytes()), "fixture portable passphrase")
	if err != nil || imported != metadata {
		t.Fatalf("manager portable round trip: %v", err)
	}
	if _, err := destination.ImportPortable(t.Context(), bytes.NewReader(output.Bytes()), "short"); !errors.Is(err, ErrPassphrase) {
		t.Fatal("invalid import passphrase accepted")
	}
	manager.options.Allowed = func() bool { return false }
	if err := manager.ExportPortable(t.Context(), metadata.ID, "fixture portable passphrase", io.Discard); !errors.Is(err, ErrBusy) {
		t.Fatal("portable export bypassed admission")
	}
	if _, err := manager.ImportPortable(t.Context(), bytes.NewReader(nil), "fixture portable passphrase"); !errors.Is(err, ErrBusy) {
		t.Fatal("portable import bypassed admission")
	}
}

func TestBackupManagerAutomaticTimerUsesVirtualClockAndJoins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, _ := vaultFixture(t)
		var checks atomic.Int32
		transport := &controlledBackupTransport{targetFn: func(context.Context, bool) (Target, error) {
			checks.Add(1)
			return Target{}, context.Canceled
		}}
		manager, err := NewManager(ManagerOptions{Context: t.Context(), DataDir: filepath.Dir(vault.directory), Vault: vault, Transport: transport, Automatic: true})
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(BackupCheckInterval)
		synctest.Wait()
		if checks.Load() != 1 || manager.retryAt != time.Now().Add(BackupRetryDelay).UnixMilli() {
			t.Fatal("automatic error did not retain bounded retry schedule")
		}
		manager.Changed()
		synctest.Wait()
		time.Sleep(BackupCheckInterval - time.Nanosecond)
		if checks.Load() != 1 {
			t.Fatal("wake caused an immediate overlapping tick")
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if checks.Load() != 2 {
			t.Fatal("timer stopped after wake")
		}
		manager.Close()
		time.Sleep(BackupCheckInterval)
		synctest.Wait()
		if checks.Load() != 2 {
			t.Fatal("closed manager retained timer goroutine")
		}
	})
}
