package backups

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func captureBoundaryFixture(t *testing.T) (workerCapture, string) {
	t.Helper()
	source := t.TempDir()
	staging := t.TempDir()
	for _, domain := range []string{"data", "workspace"} {
		if err := os.Mkdir(filepath.Join(staging, domain), 0700); err != nil {
			t.Fatal(err)
		}
	}
	return workerCapture{ctx: t.Context(), staging: staging, workspace: source}, source
}

func TestWorkerCaptureHonorsSourceAndStagingBudgetsWithoutPublishing(t *testing.T) {
	for _, mode := range []string{"missing-source", "invalid-path", "entries", "observations", "count", "bytes", "target-file", "target-directory", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			capture, source := captureBoundaryFixture(t)
			name := "retained"
			prefix := ""
			if err := os.WriteFile(filepath.Join(source, name), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing-source":
				source += "-missing"
			case "invalid-path":
				prefix = ".."
			case "entries":
				capture.entries = make([]ArchiveEntry, MaxFiles)
			case "observations":
				capture.observed = make([]observedSource, MaxFiles*5+1)
			case "count":
				capture.count = MaxFiles
			case "bytes":
				capture.bytes = MaxBackupBytes
			case "target-file":
				if err := os.WriteFile(filepath.Join(capture.staging, "workspace", name), []byte("unrelated candidate"), 0600); err != nil {
					t.Fatal(err)
				}
			case "target-directory":
				if err := os.Mkdir(filepath.Join(source, "directory"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(capture.staging, "workspace", "directory"), 0700); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				ctx, cancel := context.WithCancel(t.Context())
				cancel()
				capture.ctx = ctx
			}
			if err := capture.directory(source, "workspace", prefix); err == nil {
				t.Fatal("unsafe source or exhausted snapshot budget was accepted")
			}
			if mode != "missing-source" {
				if raw, err := os.ReadFile(filepath.Join(source, name)); err != nil || string(raw) != "original" {
					t.Fatal("rejected capture changed the original bytes", err)
				}
			}
		})
	}
}

func TestWorkerCaptureValidatesRetainedMetadataAndDatabaseGeneration(t *testing.T) {
	for _, mode := range []string{"missing-observed", "changed-version", "link-proof", "database-closed", "database-changed"} {
		t.Run(mode, func(t *testing.T) {
			capture, source := captureBoundaryFixture(t)
			name := filepath.Join(source, "original")
			if err := os.WriteFile(name, []byte("retained"), 0600); err != nil {
				t.Fatal(err)
			}
			info, err := os.Lstat(name)
			if err != nil {
				t.Fatal(err)
			}
			if err := capture.observe(name, info, ""); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing-observed":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			case "changed-version":
				capture.observed[0].changed--
			case "link-proof":
				capture.observed[0].link = "expected-symlink-target"
			case "database-closed", "database-changed":
				db, err := sql.Open("sqlite", filepath.Join(source, "generation.sqlite"))
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				if _, err := db.Exec("CREATE TABLE retained (value INTEGER)"); err != nil {
					t.Fatal(err)
				}
				var generation int64
				if err := db.QueryRow("PRAGMA data_version").Scan(&generation); err != nil {
					t.Fatal(err)
				}
				if mode == "database-closed" {
					if err := db.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					writer, err := sql.Open("sqlite", filepath.Join(source, "generation.sqlite"))
					if err != nil {
						t.Fatal(err)
					}
					if _, err := writer.Exec("INSERT INTO retained VALUES (1)"); err != nil {
						writer.Close()
						t.Fatal(err)
					}
					writer.Close()
				}
				capture.databases = []capturedDatabase{{db: db, version: generation}}
			}
			if err := capture.validate(); !errors.Is(err, ErrSourceChanged) {
				t.Fatal("unconfirmed source generation was accepted", err)
			}
		})
	}
	if _, err := sourceVersion("missing", nil); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("missing metadata acquired an invented source version", err)
	}
}

func TestWorkerSnapshotRejectsLateOwnershipChangeOrInvalidClockAndCleansStage(t *testing.T) {
	for _, mode := range []string{"owner-changed", "invalid-clock", "stage-missing", "stage-file"} {
		t.Run(mode, func(t *testing.T) {
			options := workerSnapshotFixture(t)
			if mode == "invalid-clock" {
				options.Now = func() time.Time { return time.UnixMilli(0) }
			}
			calls := 0
			options.ValidateCurrent = func(context.Context) error {
				calls++
				if calls == 2 && mode == "owner-changed" {
					return ErrConnectionChanged
				}
				return nil
			}
			backup, err := CreateWorkerBackup(t.Context(), options)
			if mode == "owner-changed" || mode == "invalid-clock" {
				if err == nil || backup != nil {
					t.Fatal("late invalid manifest or changed owner produced a backup")
				}
				assertSnapshotStagesEmpty(t, options.TemporaryRoot)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(backup.Archive.Directory); err != nil {
				t.Fatal(err)
			}
			if mode == "stage-file" {
				if err := os.WriteFile(backup.Archive.Directory, []byte("replacement must survive"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := backup.Close(); !errors.Is(err, ErrSourceChanged) {
					t.Fatal("cleanup removed an unrelated regular-file replacement", err)
				}
			} else if err := backup.Close(); err != nil {
				t.Fatal("already absent owned stage failed idempotent close", err)
			}
		})
	}
}

func TestWorkerSnapshotFileReadersRejectHardLinksCancelledCopiesAndExistingTargets(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte(strings.Repeat("opaque", 10)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := hashBackupFile(t.Context(), source+"-missing"); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing source was hashed", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := hashBackupFile(ctx, source); !errors.Is(err, context.Canceled) {
		t.Fatal("hashing ignored cancellation", err)
	}
	if _, err := copyStableBackupFile(ctx, source, filepath.Join(t.TempDir(), "cancelled")); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("cancelled private copy was published", err)
	}
	if _, err := copyStableBackupFile(t.Context(), source+"-missing", filepath.Join(t.TempDir(), "missing")); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing original became a private copy", err)
	}
	if _, err := copyStableBackupFile(t.Context(), source, source); !errors.Is(err, ErrInvalid) {
		t.Fatal("exclusive copy replaced its own source", err)
	}
	if err := os.Link(source, filepath.Join(t.TempDir(), "foreign-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := hashBackupFile(t.Context(), source); !errors.Is(err, ErrInvalid) {
		t.Fatal("hardlinked staging was hashed as exclusively owned", err)
	}
	if _, err := sqliteFile(source); !errors.Is(err, ErrInvalid) {
		t.Fatal("hardlinked source was accepted for database detection", err)
	}
}

func TestWorkerDatabaseSnapshotRejectsCorruptPagesAndExistingDestination(t *testing.T) {
	for _, mode := range []string{"corrupt-page", "destination-exists"} {
		t.Run(mode, func(t *testing.T) {
			source := filepath.Join(t.TempDir(), "original.sqlite")
			db, err := sql.Open("sqlite", source)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('original')"); err != nil {
				db.Close()
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "candidate.sqlite")
			if mode == "destination-exists" {
				if err := os.WriteFile(target, []byte("independent candidate"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				file, err := os.OpenFile(source, os.O_RDWR, 0)
				if err != nil {
					t.Fatal(err)
				}
				// Keep the valid SQLite header and corrupt the second B-tree page.
				if _, err := file.WriteAt([]byte{255}, 4096); err != nil {
					file.Close()
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(source)
			if err != nil {
				t.Fatal(err)
			}
			opened, _, err := snapshotDataSQLite(t.Context(), source, target)
			if !errors.Is(err, ErrInvalid) || opened != nil {
				if opened != nil {
					opened.Close()
				}
				t.Fatal("unverified database or pre-existing destination was accepted", err)
			}
			after, err := os.ReadFile(source)
			if err != nil || string(before) != string(after) {
				t.Fatal("failed read-only snapshot modified the original database", err)
			}
			if mode == "destination-exists" {
				if raw, err := os.ReadFile(target); err != nil || string(raw) != "independent candidate" {
					t.Fatal("failed exclusive snapshot replaced an unrelated destination", err)
				}
			}
		})
	}
}
