package memory

import (
	"bytes"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func backupConstraintFixture(t *testing.T) *Store {
	t.Helper()
	s := openStoreFixture(t)
	if _, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Synthetic retained preference", Source: Source{Kind: "user"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteProject(t.Context(), "conversation", "work", []byte(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"Synthetic retained project","attachments":[]},"humanUpdates":[],"results":[]}`)); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestReadOnlyBackupValidationRejectsEveryStoredConstraintFamily(t *testing.T) {
	for _, test := range []struct {
		name, statement string
		arguments       []any
	}{
		{"metadata count", "INSERT INTO memory_meta(id,revision,markdown_imported,search_revision) VALUES(2,0,1,-1)", nil},
		{"metadata id", "UPDATE memory_meta SET id=2 WHERE id=1", nil},
		{"revision storage type", "UPDATE memory_meta SET revision=1.5 WHERE id=1", nil},
		{"import marker", "UPDATE memory_meta SET markdown_imported=2 WHERE id=1", nil},
		{"index revision storage type", "UPDATE memory_meta SET search_revision='invalid' WHERE id=1", nil},
		{"note allowlist", "UPDATE notes SET name='foreign.md' WHERE name='identity.md'", nil},
		{"note byte limit", "UPDATE notes SET text=? WHERE name='identity.md'", []any{strings.Repeat("界", MaxNoteBytes/3+1)}},
		{"note storage type", "UPDATE notes SET text=? WHERE name='identity.md'", []any{[]byte("Synthetic blob")}},
		{"project byte limit", "UPDATE projects SET context_json=?", []any{strings.Repeat("界", MaxNoteBytes/3+1)}},
		{"project conversation storage type", "UPDATE projects SET conversation_id=?", []any{[]byte("opaque")}},
		{"project work storage type", "UPDATE projects SET work_id=?", []any{[]byte("opaque")}},
		{"entry kind", "UPDATE memory_entries SET kind='foreign'", nil},
		{"entry status", "UPDATE memory_entries SET status='foreign'", nil},
		{"entry byte limit", "UPDATE memory_entries SET text=?", []any{strings.Repeat("界", MaxEntryBytes/3+1)}},
		{"confidence bound", "UPDATE memory_entries SET confidence=1.5", nil},
		{"confidence storage type", "UPDATE memory_entries SET confidence='invalid'", nil},
		{"creation timestamp storage type", "UPDATE memory_entries SET created_at='invalid'", nil},
		{"update timestamp storage type", "UPDATE memory_entries SET updated_at='invalid'", nil},
		{"entry id storage type", "UPDATE memory_entries SET id=?", []any{[]byte("opaque")}},
		{"entry key storage type", "UPDATE memory_entries SET memory_key=?", []any{[]byte("opaque")}},
		{"entry dedupe storage type", "UPDATE memory_entries SET dedupe=?", []any{[]byte("opaque")}},
		{"entry source storage type", "UPDATE memory_entries SET source_json=?", []any{[]byte(`{}`)}},
		{"entry conflicts storage type", "UPDATE memory_entries SET conflicts_json=?", []any{[]byte(`[]`)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := backupConstraintFixture(t)
			if err := s.connection(t.Context(), func(db *sql.DB) error {
				if _, err := db.ExecContext(t.Context(), "PRAGMA ignore_check_constraints=ON"); err != nil {
					return err
				}
				_, err := db.ExecContext(t.Context(), test.statement, test.arguments...)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(s.DatabaseFile())
			if err != nil {
				t.Fatal(err)
			}
			beforeInfo, err := os.Stat(s.DatabaseFile())
			if err != nil {
				t.Fatal(err)
			}

			if err := ValidateBackupDatabase(t.Context(), s.DatabaseFile()); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("invalid stored constraint passed read-only backup validation", err)
			}
			after, readErr := os.ReadFile(s.DatabaseFile())
			afterInfo, statErr := os.Stat(s.DatabaseFile())
			if readErr != nil || statErr != nil || !bytes.Equal(before, after) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) || beforeInfo.Size() != afterInfo.Size() {
				t.Fatal("validation rewrote, repaired, or replaced the staged backup", readErr, statErr)
			}
		})
	}
}

func TestReadOnlyBackupValidationAcceptsExactByteAndConfidenceBoundaries(t *testing.T) {
	s := backupConstraintFixture(t)
	maximumNote := strings.Repeat("界", MaxNoteBytes/3) + "a"
	if len(maximumNote) != MaxNoteBytes {
		t.Fatal("note boundary fixture does not measure UTF-8 bytes")
	}
	if err := s.WriteNote(t.Context(), "identity.md", maximumNote); err != nil {
		t.Fatal(err)
	}
	maximumEntry := strings.Repeat("界", MaxEntryBytes/3) + "a"
	for index, confidence := range []*float64{nil, ptr(0.0), ptr(0.5), ptr(1.0)} {
		text := maximumEntry
		if index > 0 {
			text = text[:len(text)-1] + string(rune('a'+index))
		}
		if _, err := s.Propose(t.Context(), Proposal{Kind: "episodic", Text: text, Source: Source{Kind: "task"}, Confidence: confidence}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.connection(t.Context(), func(db *sql.DB) error {
		var length int
		if err := db.QueryRowContext(t.Context(), "SELECT length(CAST(context_json AS BLOB)) FROM projects").Scan(&length); err != nil {
			return err
		}
		_, err := db.ExecContext(t.Context(), "UPDATE projects SET context_json=context_json||?", strings.Repeat(" ", MaxNoteBytes-length))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, marker := range []int{0, 1} {
		memoryFixtureSQL(t, s, "UPDATE memory_meta SET markdown_imported=? WHERE id=1", marker)
		if err := ValidateBackupDatabase(t.Context(), s.DatabaseFile()); err != nil {
			t.Fatal("valid exact-boundary memory database was rejected", err)
		}
	}
}

func TestBackupConstraintQueryFailureIsClassifiedWithoutWritingAnyRows(t *testing.T) {
	s := backupConstraintFixture(t)
	if err := s.transaction(t.Context(), false, func(tx *sql.Tx) error {
		if err := tx.Rollback(); err != nil {
			return err
		}
		if err := validateBackupConstraints(t.Context(), tx); !errors.Is(err, ErrInvalidSnapshot) {
			t.Fatal("unavailable backup query did not fail closed", err)
		}
		return nil
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("closed backup transaction was reported committed", err)
	}
	if entries, err := s.Entries(t.Context(), contracts.MemoryEntryStatusCandidate); err != nil || len(entries) != 1 {
		t.Fatal("failed backup query changed authoritative entries", err)
	}
}
