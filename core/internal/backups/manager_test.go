package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type transportFixture struct {
	mu             sync.Mutex
	target         Target
	source         Metadata
	restoreCalls   int
	reconcileCalls int
	confirm        bool
	failRestore    bool
	receiptFile    string
}

func (fixture *transportFixture) Target(context.Context, bool) (Target, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.target, nil
}

func (fixture *transportFixture) Export(context.Context) (ExportSource, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return ExportSource{Metadata: fixture.source, Stream: io.NopCloser(bytes.NewReader(fixtureArchive([]byte("{}"))))}, nil
}

func (fixture *transportFixture) Restore(_ context.Context, input io.Reader, _ string, _ Target) error {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.restoreCalls++
	if _, err := os.Stat(fixture.receiptFile); err != nil {
		return errors.New("receipt was not reserved")
	}

	if _, err := io.Copy(io.Discard, input); err != nil {
		return err
	}

	if fixture.failRestore {
		return errors.New("fixture unknown outcome")
	}

	return nil
}

func (fixture *transportFixture) Reconcile(context.Context, string, Target) (bool, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.reconcileCalls++
	return fixture.confirm, nil
}

func (fixture *transportFixture) Rejected(context.Context, string, Target) (bool, error) {
	return false, nil
}

func waitManager(t *testing.T, manager *Manager, changed <-chan struct{}) {
	t.Helper()
	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	for {
		manager.mu.Lock()
		pending := manager.pending
		manager.mu.Unlock()
		if !pending {
			return
		}
		select {
		case <-changed:
		case <-timeout.C:
			t.Fatal("bounded fixture backup did not finish")
		}
	}
}

func managerFixture(t *testing.T) (*Manager, *transportFixture, Metadata, <-chan struct{}, *atomic.Int64) {
	t.Helper()
	vault, metadata := vaultFixture(t)
	metadata.CreatedAt = 1000000
	if err := vault.Save(context.Background(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
		t.Fatal(err)
	}
	version := metadata.AppVersion
	transport := &transportFixture{target: Target{Identity: strings.Repeat("a", 64), Generation: 1, Online: true, Supported: true, Version: &version}, source: metadata, receiptFile: filepath.Join(filepath.Dir(vault.directory), "backup-restore.json")}
	changed := make(chan struct{}, 32)
	now := &atomic.Int64{}
	now.Store(1000000)
	manager, err := NewManager(ManagerOptions{Context: context.Background(), DataDir: filepath.Dir(vault.directory), Vault: vault, Transport: transport, Now: func() time.Time { return time.UnixMilli(now.Load()) }, Changed: func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	return manager, transport, metadata, changed, now
}

func TestBackupManagerPreservesUnknownRestoreAcrossRestartWithoutReplay(t *testing.T) {
	manager, transport, metadata, changed, _ := managerFixture(t)
	transport.failRestore = true
	preview, err := manager.PreviewRestore(context.Background(), metadata.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := manager.Restore(metadata.ID, preview.Confirmation); err != nil {
		t.Fatal(err)
	}
	waitManager(t, manager, changed)
	if manager.Phase() != contracts.BackupPhaseUnknown {
		t.Fatal("unfinished remote restore was treated as failure/safe retry")
	}

	if err := manager.Run(); !errors.Is(err, ErrRestoreUnconfirmed) {
		t.Fatal("unknown restore admitted new backup")
	}
	manager.Close()
	restarted, err := NewManager(manager.options)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if restarted.Phase() != contracts.BackupPhaseUnknown {
		t.Fatal("restart forgot durable restore receipt")
	}
	transport.mu.Lock()
	transport.confirm = true
	transport.mu.Unlock()
	if err := restarted.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	transport.mu.Lock()
	calls := transport.restoreCalls
	checks := transport.reconcileCalls
	transport.mu.Unlock()
	if calls != 1 || checks == 0 || restarted.Phase() != contracts.BackupPhaseIdle {
		t.Fatal("reconciliation replayed external restore or failed exact receipt")
	}

	if _, err := os.Stat(transport.receiptFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("confirmed exact receipt not cleared")
	}
}

func TestBackupManagerBindsPreviewToConnectionAndPersistsSettings(t *testing.T) {
	manager, transport, metadata, changed, _ := managerFixture(t)
	preview, err := manager.PreviewRestore(context.Background(), metadata.ID)
	if err != nil {
		t.Fatal(err)
	}
	transport.mu.Lock()
	transport.target.Generation++
	transport.mu.Unlock()
	if err := manager.Restore(metadata.ID, preview.Confirmation); err != nil {
		t.Fatal(err)
	}
	waitManager(t, manager, changed)
	transport.mu.Lock()
	calls := transport.restoreCalls
	transport.mu.Unlock()
	if calls != 0 || manager.Phase() != contracts.BackupPhaseFailed {
		t.Fatal("stale preview restored another connection")
	}

	if err := manager.Configure(context.Background(), []byte(`{"mode":"manual","onConnect":false,"retainCount":3}`)); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(manager.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	status, err := reloaded.Status(context.Background())
	if err != nil || status.Settings.Mode != contracts.BackupModeManual || status.Settings.OnConnect || status.Settings.RetainCount != 3 || status.NextAt != nil {
		t.Fatal("manual backup preferences not persisted")
	}
	for _, raw := range []string{`{"retainCount":0}`, `{"onConnect":null}`, `{"mode":"unknown"}`, `{"intervalMinutes":14}`, `{"arbitrary":true}`} {
		if err := reloaded.Configure(context.Background(), []byte(raw)); !errors.Is(err, ErrSettings) {
			t.Fatal("invalid settings accepted")
		}
	}
}

func TestBeforeVMChangeStartsBackupThenRequiresExplicitRetry(t *testing.T) {
	manager, _, _, changed, _ := managerFixture(t)
	if err := manager.BeforeVMChange(context.Background()); !errors.Is(err, ErrBeforeVMChange) {
		t.Fatal("VM change admitted before required backup")
	}
	waitManager(t, manager, changed)
	if err := manager.BeforeVMChange(context.Background()); err != nil {
		t.Fatal("fresh captured source backup did not release explicit change retry")
	}
}
