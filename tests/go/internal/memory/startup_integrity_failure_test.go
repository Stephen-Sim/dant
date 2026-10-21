package memory

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMemoryStartupWriteFailuresRetainPreviouslyCommittedNotes(t *testing.T) {
	for _, phase := range []string{"backup", "note insert", "import marker", "index marker", "snapshot export"} {
		t.Run(phase, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "Synthetic retained SQL identity"); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(s.Directory(), "identity.md")
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			memoryFixtureSQL(t, s, "UPDATE memory_meta SET markdown_imported=0 WHERE id=1")
			switch phase {
			case "backup":
				s.snapshots.mkdir = func(string, fs.FileMode) error {
					return errors.New("private fixture backup failure")
				}
			case "note insert":
				memoryFixtureSQL(t, s, `CREATE TRIGGER isolated_import_failure BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'private fixture insert failure'); END`)
			case "import marker":
				memoryFixtureSQL(t, s, `CREATE TRIGGER isolated_import_failure BEFORE UPDATE ON memory_meta WHEN NEW.markdown_imported=1 AND OLD.markdown_imported=0 BEGIN SELECT RAISE(ABORT,'private fixture marker failure'); END`)
			case "index marker":
				memoryFixtureSQL(t, s, `CREATE TRIGGER isolated_import_failure BEFORE UPDATE ON memory_meta WHEN OLD.markdown_imported=1 AND NEW.search_revision=-1 BEGIN SELECT RAISE(ABORT,'private fixture index failure'); END`)
			case "snapshot export":
				if err := os.Remove(filepath.Join(s.Directory(), "working-memory.md")); err != nil {
					t.Fatal(err)
				}
				s.snapshots.writeAtomic = func(_ context.Context, _ string, _ []byte, _ fs.FileMode) error {
					return errors.New("private fixture export failure")
				}
			}

			var startupErr error
			err = s.connection(t.Context(), func(db *sql.DB) error {
				startupErr = s.initialize(t.Context(), db)
				return startupErr
			})
			if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "private fixture") {
				t.Fatal("incomplete startup became available or exposed storage details", err)
			}
			if (phase == "note insert" || phase == "import marker" || phase == "index marker") && (startupErr == nil || !strings.Contains(startupErr.Error(), "private fixture")) {
				t.Fatal("startup stopped before its intended isolated failure", startupErr)
			}
			text, err := s.ReadNote(t.Context(), "identity.md")
			after, readErr := os.ReadFile(file)
			if err != nil || readErr != nil || text != "Synthetic retained SQL identity" || !bytes.Equal(before, after) {
				t.Fatal("failed startup changed SQL authority or its original snapshot", err, readErr)
			}
			var imported int
			err = s.connection(t.Context(), func(db *sql.DB) error {
				return db.QueryRowContext(t.Context(), "SELECT markdown_imported FROM memory_meta WHERE id=1").Scan(&imported)
			})
			committed := phase == "snapshot export"
			if err != nil || committed && imported != 1 || !committed && imported != 0 {
				t.Fatal("startup failure lost the actual transaction commit boundary", err)
			}
		})
	}
}

func TestMemoryStartupRefusesReadOnlyInitializationWithoutChangingCanonicalNotes(t *testing.T) {
	for _, phase := range []string{"journal mode", "schema write"} {
		t.Run(phase, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "Synthetic retained read-only identity"); err != nil {
				t.Fatal(err)
			}
			err := s.connection(t.Context(), func(db *sql.DB) error {
				if phase == "journal mode" {
					if _, err := db.ExecContext(t.Context(), "PRAGMA journal_mode=WAL"); err != nil {
						return err
					}
				}
				if _, err := db.ExecContext(t.Context(), "PRAGMA query_only=ON"); err != nil {
					return err
				}
				return s.initialize(t.Context(), db)
			})
			if !errors.Is(err, ErrUnavailable) {
				t.Fatal("read-only startup reported a successful writable authority", err)
			}
			text, err := s.ReadNote(t.Context(), "identity.md")
			if err != nil || text != "Synthetic retained read-only identity" {
				t.Fatal("failed initialization changed its canonical note", err)
			}
		})
	}
}

func TestMemoryStartupAndBackupValidationRejectActualSQLiteConstraintCorruption(t *testing.T) {
	for _, corrupt := range []string{"note length", "import marker"} {
		t.Run(corrupt, func(t *testing.T) {
			s := openStoreFixture(t)
			root := filepath.Dir(filepath.Dir(s.Directory()))
			statement, argument := "UPDATE notes SET text=? WHERE name='identity.md'", any(strings.Repeat("x", MaxNoteBytes+1))
			if corrupt == "import marker" {
				statement, argument = "UPDATE memory_meta SET markdown_imported=? WHERE id=1", "invalid integer"
			}
			if err := s.connection(t.Context(), func(db *sql.DB) error {
				if _, err := db.ExecContext(t.Context(), "PRAGMA ignore_check_constraints=ON"); err != nil {
					return err
				}
				_, err := db.ExecContext(t.Context(), statement, argument)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			var stored string
			query := "SELECT length(CAST(text AS BLOB)) FROM notes WHERE name='identity.md'"
			if corrupt == "import marker" {
				query = "SELECT markdown_imported FROM memory_meta WHERE id=1"
			}
			if err := s.connection(t.Context(), func(db *sql.DB) error {
				return db.QueryRowContext(t.Context(), query).Scan(&stored)
			}); err != nil {
				t.Fatal(err)
			}
			if corrupt == "note length" && stored != "65537" || corrupt == "import marker" && stored != "invalid integer" {
				t.Fatal("isolated corruption was not persisted before validation")
			}
			before, err := os.ReadFile(s.DatabaseFile())
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateBackupDatabase(t.Context(), s.DatabaseFile()); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("corrupt SQLite constraints passed backup validation", err)
			}
			after, err := os.ReadFile(s.DatabaseFile())
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("read-only backup validation changed its staged database", err)
			}
			opened, err := OpenStore(t.Context(), root, StoreOptions{})
			if err == nil || opened != nil {
				if opened != nil {
					opened.Close()
				}
				t.Fatal("corrupt SQLite state was silently adopted on startup")
			}
		})
	}
}

func TestMemoryBackupValidationRejectsAMissingSearchIndex(t *testing.T) {
	s := openStoreFixture(t)
	memoryFixtureSQL(t, s, "DROP TABLE memory_search")
	if err := ValidateBackupDatabase(t.Context(), s.DatabaseFile()); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("incomplete memory database passed backup validation", err)
	}
}
