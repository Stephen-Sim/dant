package backups

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerCaptureUsesAConsistentDataSQLiteSnapshotAndOmitsItsLiveWALSidecars(t *testing.T) {
	options := workerSnapshotFixture(t)
	name := filepath.Join(options.DataDir, "owned.sqlite")
	db, err := sql.Open("sqlite", name)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('saved in WAL')"); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(name + suffix); err != nil {
			t.Fatal("fixture did not retain live SQLite sidecars", err)
		}
	}
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	for _, entry := range backup.Archive.Entries {
		if strings.HasSuffix(entry.Path, "-wal") || strings.HasSuffix(entry.Path, "-shm") {
			t.Fatal("data snapshot serialized a live SQLite sidecar")
		}
	}
	copied, err := sql.Open("sqlite", filepath.Join(backup.Archive.Directory, "data", "owned.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Close()
	var value string
	if err := copied.QueryRow("SELECT value FROM retained").Scan(&value); err != nil || value != "saved in WAL" {
		t.Fatal("private database snapshot lost committed WAL content", err)
	}
}

func TestWorkerCaptureRejectsAnOrphanSidecarWhoseMainPathIsADirectory(t *testing.T) {
	options := workerSnapshotFixture(t)
	main := filepath.Join(options.DataDir, "ambiguous.sqlite")
	if err := os.Mkdir(main, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(main+"-wal", []byte("retained sidecar bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if backup, err := CreateWorkerBackup(t.Context(), options); !errors.Is(err, ErrInvalid) || backup != nil {
		t.Fatal("ambiguous SQLite sidecar was captured without an ordinary main file", err)
	}
	assertSnapshotStagesEmpty(t, options.TemporaryRoot)
	if raw, err := os.ReadFile(main + "-wal"); err != nil || string(raw) != "retained sidecar bytes" {
		t.Fatal("rejected sidecar detection modified source evidence", err)
	}
}

func TestFirefoxLockConsumerRejectsOrdinaryFilesWithoutReadingUnrelatedTargets(t *testing.T) {
	capture, directory := captureBoundaryFixture(t)
	name := filepath.Join(directory, "lock")
	if err := os.WriteFile(name, []byte("ordinary user file"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(name)
	if err != nil {
		t.Fatal(err)
	}
	if skipped, err := capture.firefoxLock(directory, name, info); err != nil || skipped || len(capture.observed) != 0 {
		t.Fatal("ordinary file acquired the special browser runtime-lock exclusion", err)
	}
}

func TestRestoreKeepsOriginalRootsWhenWriteFailureLeavesUnusableRecoveryEvidence(t *testing.T) {
	for _, temporary := range []bool{false, true} {
		t.Run(map[bool]string{false: "invalid journal", true: "unremovable temporary evidence"}[temporary], func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			storage := restoreTransactionStorage()
			writes := 0
			storage.writeJSON = func(context.Context, string, any) error {
				writes++
				if temporary {
					if err := os.Mkdir(locations.journal+".tmp", 0700); err != nil {
						return err
					}
				} else if err := os.WriteFile(locations.journal, []byte("unreadable retained journal"), 0600); err != nil {
					return err
				}
				return io.ErrClosedPipe
			}
			if receipt, err := runRestoreTransaction(t, t.Context(), options, storage); !errors.Is(err, io.ErrClosedPipe) || receipt.Restored || writes != 1 {
				t.Fatal("failed write was repeated or acknowledged as a committed restore", err)
			}
			assertOriginalRestoreRoots(t, options)
			if _, err := RecoverWorkerRestore(t.Context(), options); !errors.Is(err, ErrRestoreFailed) {
				t.Fatal("unusable evidence was treated as a settled recovery", err)
			}
			reader := &restoreReadCounter{}
			if receipt, err := RestoreWorkerBackup(t.Context(), options, reader); !errors.Is(err, ErrRestoreFailed) || receipt.Restored || reader.reads != 0 {
				t.Fatal("unreconciled recovery evidence authorized another archive read", err)
			}
			assertOriginalRestoreRoots(t, options)
		})
	}
}

func TestRestoreConsumerRejectsInvalidSavedReceiptsBeforeReadingANewArchive(t *testing.T) {
	options := restoreFixture(t)
	name := filepath.Join(options.DataDir, WorkerRestoreReceiptFile)
	original := []byte("invalid retained receipt")
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	reader := &restoreReadCounter{}
	if receipt, err := RestoreWorkerBackup(t.Context(), options, reader); !errors.Is(err, ErrRestoreFailed) || receipt.Restored || reader.reads != 0 {
		t.Fatal("invalid saved receipt permitted an archive replay", err)
	}
	if raw, err := os.ReadFile(name); err != nil || !bytes.Equal(raw, original) {
		t.Fatal("failed receipt inspection rewrote its unknown evidence", err)
	}
	assertOriginalRestoreRoots(t, options)
}
