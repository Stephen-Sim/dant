package backups

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workerSnapshotFixture(t *testing.T) WorkerBackupOptions {
	t.Helper()
	data, workspace := cliRoots(t)
	return WorkerBackupOptions{DataDir: data, WorkspaceRoot: workspace, TemporaryRoot: t.TempDir(), SourceID: "private-fixture", AppVersion: "0.4.7-beta.20"}
}

func assertSnapshotStagesEmpty(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("snapshot failure leaked a private stage")
	}
}

func TestWorkerSnapshotRejectsInvalidRootsBeforeCapturingUserData(t *testing.T) {
	for _, mode := range []string{"relative", "source", "version", "missing-data", "same-root", "data-inside-workspace", "missing-temp", "state-directory", "state-hardlink", "initial-owner", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			options := workerSnapshotFixture(t)
			temporary := options.TemporaryRoot
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "relative":
				options.DataDir = "relative"
			case "source":
				options.SourceID = "unsafe source"
			case "version":
				options.AppVersion = "unknown version"
			case "missing-data":
				options.DataDir += "-missing"
			case "same-root":
				options.WorkspaceRoot = options.DataDir
			case "data-inside-workspace":
				options.DataDir = filepath.Join(options.WorkspaceRoot, "data")
				if err := os.Mkdir(options.DataDir, 0700); err != nil {
					t.Fatal(err)
				}
			case "missing-temp":
				options.TemporaryRoot += "-missing"
			case "state-directory":
				if err := os.Remove(filepath.Join(options.DataDir, "state.json")); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(options.DataDir, "state.json"), 0700); err != nil {
					t.Fatal(err)
				}
			case "state-hardlink":
				if err := os.Link(filepath.Join(options.DataDir, "state.json"), filepath.Join(t.TempDir(), "foreign-link")); err != nil {
					t.Fatal(err)
				}
			case "initial-owner":
				options.ValidateCurrent = func(context.Context) error { return ErrConnectionChanged }
			case "cancelled":
				cancel()
			}
			backup, err := CreateWorkerBackup(ctx, options)
			if err == nil || backup != nil {
				t.Fatal("invalid snapshot admission returned an archive")
			}
			assertSnapshotStagesEmpty(t, temporary)
		})
	}
}

func TestWorkerSnapshotDataSQLiteMustBeValidButWorkspaceBytesStayOpaque(t *testing.T) {
	for _, mode := range []string{"invalid-sqlite", "sqlite-sidecar-hardlink", "source-replaced", "new-sidecar", "cancelled-after-copy"} {
		t.Run(mode, func(t *testing.T) {
			options := workerSnapshotFixture(t)
			file := filepath.Join(options.DataDir, "fixture.sqlite")
			if mode == "invalid-sqlite" {
				if err := os.WriteFile(file, append([]byte(sqliteMagic), []byte("not a database")...), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				db, err := sql.Open("sqlite", file)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('fixture')"); err != nil {
					t.Fatal(err)
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "sqlite-sidecar-hardlink" {
				sidecar := file + "-wal"
				if err := os.WriteFile(sidecar, []byte("opaque sidecar"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(sidecar, filepath.Join(t.TempDir(), "sidecar-link")); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			calls := 0
			options.ValidateCurrent = func(context.Context) error {
				calls++
				if calls != 2 {
					return nil
				}
				switch mode {
				case "source-replaced":
					state := filepath.Join(options.DataDir, "state.json")
					if err := os.Rename(state, state+"-evidence"); err != nil {
						t.Fatal(err)
					}
					return os.WriteFile(state, []byte(cliFixtureState), 0600)
				case "new-sidecar":
					return os.WriteFile(file+"-journal", []byte("new write after capture"), 0600)
				case "cancelled-after-copy":
					cancel()
				}
				return nil
			}
			if backup, err := CreateWorkerBackup(ctx, options); err == nil || backup != nil {
				t.Fatal("corrupt database or changed/cancelled source published backup")
			}
			assertSnapshotStagesEmpty(t, options.TemporaryRoot)
		})
	}
}

func TestWorkerSnapshotClosesEverySQLiteConnectionOnConnectionLimit(t *testing.T) {
	options := workerSnapshotFixture(t)
	for index := 0; index <= sqliteConnectionLimit; index++ {
		name := filepath.Join(options.DataDir, fmt.Sprintf("%03d.sqlite", index))
		db, err := sql.Open("sqlite", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("CREATE TABLE preserved (value INTEGER)"); err != nil {
			t.Fatal(err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := CreateWorkerBackup(t.Context(), options); !errors.Is(err, ErrSizeLimit) {
		t.Fatalf("unbounded database snapshots accepted: %v", err)
	}
	assertSnapshotStagesEmpty(t, options.TemporaryRoot)
	for index := 0; index <= sqliteConnectionLimit; index++ {
		name := filepath.Join(options.DataDir, fmt.Sprintf("%03d.sqlite", index))
		db, err := sql.Open("sqlite", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO preserved VALUES (1); COMMIT"); err != nil {
			db.Close()
			t.Fatal("failed snapshot retained a live SQLite connection")
		}
		db.Close()
	}
}

func TestWorkerSnapshotCloseDoesNotRemoveAReplacedPrivateDirectory(t *testing.T) {
	options := workerSnapshotFixture(t)
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	stage := backup.Archive.Directory
	evidence := stage + "-original"
	if err := os.Rename(stage, evidence); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(stage, "unrelated")
	if err := os.WriteFile(marker, []byte("must survive"), 0600); err != nil {
		t.Fatal(err)
	}
	first, second := backup.Close(), backup.Close()
	raw, err := os.ReadFile(marker)
	if !errors.Is(first, ErrSourceChanged) || !errors.Is(second, ErrSourceChanged) || err != nil || string(raw) != "must survive" {
		t.Fatalf("cleanup lost replacement ownership: first=%v second=%v markerPreserved=%v", first, second, err == nil)
	}
}

func TestWorkerSnapshotNestedWorkspaceIsCapturedOnceAndNonDatabaseSidecarsSurvive(t *testing.T) {
	options := workerSnapshotFixture(t)
	options.WorkspaceRoot = filepath.Join(options.DataDir, "workspace")
	if err := os.Mkdir(options.WorkspaceRoot, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"notes", "notes-wal", "orphan-journal"} {
		if err := os.WriteFile(filepath.Join(options.DataDir, name), []byte("opaque"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(options.WorkspaceRoot, "project"), []byte("one copy"), 0700); err != nil {
		t.Fatal(err)
	}
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var output bytes.Buffer
	if err := backup.WriteTo(t.Context(), &output); err != nil {
		t.Fatal(err)
	}
	if strings.Count(output.String(), `"path":"project"`) != 1 || strings.Contains(output.String(), `"path":"workspace/project"`) || !strings.Contains(output.String(), `"path":"orphan-journal"`) {
		t.Fatal("nested workspace duplicated or opaque non-SQLite sidecar omitted")
	}
}
