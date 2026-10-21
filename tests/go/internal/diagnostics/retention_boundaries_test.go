package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestDiagnosticRetentionEvictsOldestOwnedFilesBeforeAdoptingTheCache(t *testing.T) {
	directory := t.TempDir()
	now := time.Now().UTC().Truncate(time.Millisecond)
	paths := make([]string, 0, 3)
	for index, id := range []string{
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000002",
		"00000000-0000-4000-8000-000000000003",
	} {
		paths = append(paths, writeDiagnosticFixture(t, directory, id, now.Add(time.Duration(index-3)*time.Minute), strings.Repeat("x", 100)+"\n"))
	}
	unowned := filepath.Join(directory, "logs", "keep-user-file.txt")
	if err := os.WriteFile(unowned, []byte("authored content"), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := newLogger(t, Options{DataDir: directory, Role: "worker", MaxTotalBytes: 300, Now: func() time.Time { return now }})
	logger.Close()
	if status := logger.Status(); status.LastError != nil || status.FileCount != 1 || status.TotalBytes > 300 {
		t.Fatal("retention did not establish a bounded owned cache", status)
	}
	for _, path := range paths[:2] {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("older owned log was retained", err)
		}
	}
	if _, err := os.Stat(paths[2]); err != nil {
		t.Fatal("newest owned log was discarded", err)
	}
	logger.current = filepath.Base(paths[2])
	if err := logger.remove(logger.retained[0]); err != nil || logger.current != "" {
		t.Fatal("removing the active retained file left its cache identity usable", err)
	}
	if raw, err := os.ReadFile(unowned); err != nil || string(raw) != "authored content" {
		t.Fatal("retention changed an unowned file", err)
	}
}

func TestDiagnosticScanRejectsMalformedOwnershipMarkersAndOversizedDirectories(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, mode := range []string{"header", "created-at", "directory-capacity"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			logger := newLogger(t, Options{DataDir: directory, Role: "worker"})
			logger.Close()
			name := writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", now, "")
			switch mode {
			case "header":
				if err := os.WriteFile(name, []byte("not a schema marker\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "created-at":
				if err := os.WriteFile(name, []byte(`{"schema":"`+Schema+`","id":"00000000-0000-4000-8000-000000000001","createdAt":"invalid"}`+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "directory-capacity":
				for index := 0; index < MaxDirectoryFiles; index++ {
					name := filepath.Join(directory, "logs", time.Unix(int64(index), 0).UTC().Format("150405"))
					if err := os.WriteFile(name, nil, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			items, err := logger.scan(t.Context(), false)
			if mode == "directory-capacity" {
				if !errors.Is(err, files.ErrFileLimit) {
					t.Fatal("unbounded directory was scanned", err)
				}
			} else if err != nil || len(items) != 0 {
				t.Fatal("a malformed ownership marker was adopted", err)
			}
			if _, err := os.Stat(name); err != nil {
				t.Fatal("read-only scan removed an unconfirmed file", err)
			}
		})
	}
}

func TestDiagnosticReadRejectsMalformedFieldsAndCancellationBetweenRecords(t *testing.T) {
	directory := t.TempDir()
	now := time.Now().UTC().Truncate(time.Millisecond)
	record := `{"event":"synthetic.valid","at":"` + iso(now) + `","code":9,"status":"online"}` + "\n"
	invalid := `{"event":"synthetic.invalid","at":"invalid"}` + "\n" + `{"event":"synthetic.expired","at":"` + iso(now.Add(-Retention)) + `"}` + "\n"
	writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", now, invalid+record+record)
	reading, cancel := context.WithCancel(t.Context())
	defer cancel()
	cancelDuringRead := false
	logger := newLogger(t, Options{DataDir: directory, Role: "worker", Now: func() time.Time {
		if cancelDuringRead {
			cancel()
		}
		return now
	}})
	logger.Close()
	items, err := logger.Recent(t.Context(), 10)
	if err != nil || len(items) != 2 || items[0].Code != "" || items[0].Status != "online" {
		t.Fatal("persisted malformed fields or expired records bypassed validation", err)
	}
	if raw := metadata(contracts.RawObject{"code": json.RawMessage(`false`)}); len(raw) != 0 {
		t.Fatal("non-text operational metadata was retained")
	}
	cancelDuringRead = true
	if items, err := logger.Recent(reading, 10); !errors.Is(err, context.Canceled) || items != nil {
		t.Fatal("cancelled diagnostics returned a partial snapshot", err)
	}
}

func TestDiagnosticAppendRefusesOversizedOrChangedFilesWithoutDeletingThem(t *testing.T) {
	directory := t.TempDir()
	logger := newLogger(t, Options{DataDir: directory, Role: "worker", MaxFileBytes: 256})
	if logger.Log("synthetic.record", Fields{Code: strings.Repeat("x", MaxLineBytes+1)}) || logger.Status().LastError == nil || *logger.Status().LastError != "LOG_RECORD_TOO_LARGE" {
		t.Fatal("oversized diagnostic input entered the queue")
	}
	logger.Close()
	if err := logger.append(bytes.Repeat([]byte("x"), 300)); !errors.Is(err, files.ErrFileLimit) {
		t.Fatal("oversized log exceeded its file limit", err)
	}
	if err := logger.append([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(directory, "logs", logger.current)
	changed := []byte("externally changed synthetic log")
	if err := os.WriteFile(name, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := logger.append([]byte("{}\n")); !errors.Is(err, files.ErrFileChanged) || logger.cacheReady {
		t.Fatal("changed active file retained its trusted cache", err)
	}
	if raw, err := os.ReadFile(name); err != nil || !bytes.Equal(raw, changed) {
		t.Fatal("append modified unconfirmed log contents", err)
	}
}

func TestDiagnosticPeriodicFailureAndBlockedCancellationReleaseTheWriter(t *testing.T) {
	for _, mode := range []string{"cleanup-failure", "cancel-blocked-cleanup"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				logger, err := New(ctx, Options{DataDir: t.TempDir(), Role: "worker"})
				if err != nil {
					t.Fatal(err)
				}
				defer logger.Close()
				if mode == "cleanup-failure" {
					if err := os.Remove(logger.status.Directory); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(logger.status.Directory, []byte("unowned replacement"), 0o600); err != nil {
						t.Fatal(err)
					}
				} else {
					logger.fileGate <- struct{}{}
				}
				synctest.Wait()
				time.Sleep(CleanupInterval + time.Second)
				synctest.Wait()
				if mode == "cleanup-failure" {
					if code := logger.Status().LastError; code == nil || *code != "LOG_CLEANUP_FAILED" {
						t.Fatal("periodic storage failure was not surfaced")
					}
				} else {
					cancel()
					synctest.Wait()
					<-logger.fileGate
				}
				if err := logger.Close(); err != nil {
					t.Fatal("diagnostic writer failed to join", err)
				}
			})
		})
	}
}
