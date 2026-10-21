package memory

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func memoryFixtureSQL(t *testing.T, s *Store, statement string, args ...any) {
	t.Helper()
	db, err := sql.Open("sqlite", s.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(statement, args...); err != nil {
		t.Fatal(err)
	}
}

func TestMarkdownImportRejectsAReplacedFileWithIdenticalSizeAndTimestamp(t *testing.T) {
	s := openStoreFixture(t)
	file := filepath.Join(s.Directory(), "identity.md")
	if err := s.WriteNote(t.Context(), "identity.md", "SQLite remains authoritative"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(s.Directory(), "retained-original.md")
	disk := s.snapshots
	s.snapshots.open = func(path string) (snapshotReader, error) {
		if err := os.Rename(path, retained); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte("replaced"), 0600); err != nil {
			return nil, err
		}
		if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
			return nil, err
		}
		return disk.open(path)
	}
	if err := s.ImportMarkdown(t.Context(), "identity.md"); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("replacement inherited the captured file identity", err)
	}
	text, err := s.ReadNote(t.Context(), "identity.md")
	old, oldErr := os.ReadFile(retained)
	current, currentErr := os.ReadFile(file)
	if err != nil || oldErr != nil || currentErr != nil || text != "SQLite remains authoritative" || string(old) != "original" || string(current) != "replaced" {
		t.Fatal("failed import changed SQL authority or either file", err, oldErr, currentErr)
	}
}

func TestContextIncludesOnlyBoundedConfirmedEntriesAndRebuildsAfterDelete(t *testing.T) {
	s := openStoreFixture(t)
	for index := range ContextEntryLimit + 2 {
		entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: strings.Repeat("x", index+1), Source: Source{Kind: "user"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Confirm(t.Context(), entry.ID, false); err != nil {
			t.Fatal(err)
		}
	}
	text, err := s.Context(t.Context(), true)
	if err != nil || !strings.Contains(text, "## Confirmed memory") || strings.Count(text, "[semantic]") != ContextEntryLimit {
		t.Fatal("confirmed entries were omitted or the context budget was exceeded", err)
	}
	entries, err := s.Entries(t.Context(), contracts.MemoryEntryStatusConfirmed)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if _, err := s.Delete(t.Context(), entry.ID); err != nil {
			t.Fatal(err)
		}
	}
	text, err = s.Context(t.Context(), true)
	if err != nil || strings.Contains(text, "[semantic]") {
		t.Fatal("deleted memory survived the committed revision", err)
	}
}

func TestManagementRejectsInvalidActionsAndLeavesRevisionAndContentUnchanged(t *testing.T) {
	s := openStoreFixture(t)
	entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Durable original", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Confirm(t.Context(), entry.ID, false); err != nil {
		t.Fatal(err)
	}
	before, err := s.ManagementSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	secret, invalid := "password=fixture-sensitive-value", "bad\x00note"
	for _, mutation := range []Mutation{
		{Action: "unknown", Kind: "note", ID: "identity.md"},
		{Action: "confirm", Kind: "note", ID: "identity.md"},
		{Action: "delete", Kind: "note", ID: "README.md"},
		{Action: "update", Kind: "note", ID: "identity.md"},
		{Action: "update", Kind: "note", ID: "identity.md", Text: &invalid},
		{Action: "update", Kind: "note", ID: "identity.md", Text: &secret},
		{Action: "confirm", Kind: "semantic", ID: entry.ID},
		{Action: "update", Kind: "semantic", ID: entry.ID},
		{Action: "update", Kind: "semantic", ID: entry.ID, Text: &secret},
		{Action: "delete", Kind: "episodic", ID: entry.ID},
		{Action: "delete", Kind: "semantic", ID: "missing"},
	} {
		mutation.Revision = before.Revision
		if _, err := s.Manage(t.Context(), mutation); err == nil {
			t.Fatal("invalid management mutation accepted", mutation.Action, mutation.Kind)
		}
		after, err := s.ManagementSnapshot(t.Context())
		if err != nil || after.Revision != before.Revision || len(after.Entries) != 1 || after.Entries[0].Text != "Durable original" {
			t.Fatal("rejected mutation changed committed memory", err)
		}
	}
	if err := s.WriteNote(t.Context(), "unknown.md", "text"); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("unknown note name accepted", err)
	}
	if err := s.WriteNote(t.Context(), "identity.md", invalid); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid note text accepted", err)
	}
}

func TestMemoryFileGuardsRejectChangedDirectoriesDatabaseAndSidecars(t *testing.T) {
	for _, kind := range []string{"directory", "database", "journal", "wal", "shm", "oversized note"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			switch kind {
			case "directory":
				if err := os.Rename(s.dir, s.dir+"-retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(s.dir, 0700); err != nil {
					t.Fatal(err)
				}
			case "database":
				if err := os.Rename(s.file, s.file+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(s.file, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "oversized note":
				if err := os.WriteFile(filepath.Join(s.dir, "identity.md"), bytes.Repeat([]byte("x"), MaxNoteBytes+1), 0600); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.Mkdir(s.file+"-"+kind, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Notes(t.Context()); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("changed persisted identity was trusted", kind, err)
			}
		})
	}
}

func TestBackupValidationRejectsInvalidFilesCancelledReadsAndRevisionCorruption(t *testing.T) {
	for _, kind := range []string{"missing", "directory", "cancelled", "negative revision", "oversized revision", "negative index", "future index"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			file, ctx := s.DatabaseFile(), t.Context()
			switch kind {
			case "missing":
				file += ".missing"
			case "directory":
				file = s.Directory()
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "negative revision":
				memoryFixtureSQL(t, s, "PRAGMA ignore_check_constraints=ON;UPDATE memory_meta SET revision=-1")
			case "oversized revision":
				memoryFixtureSQL(t, s, "UPDATE memory_meta SET revision=?", int64(maxSafeInteger+1))
			case "negative index":
				memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=-2")
			case "future index":
				memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=revision+1")
			}
			if err := ValidateBackupDatabase(ctx, file); err == nil {
				t.Fatal("unverified backup was accepted", kind)
			}
		})
	}
}
