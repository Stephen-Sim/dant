package memory

import (
	"database/sql"
	"strings"
	"testing"
)

func TestMemorySQLWriteFailuresRollbackAndExposeOnlyClassifiedErrors(t *testing.T) {
	for _, test := range []struct {
		name, table, action string
		write               func(*Store, string) error
	}{
		{"propose", "memory_entries", "INSERT", func(s *Store, _ string) error {
			_, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "New remembered preference", Source: Source{Kind: "user"}})
			return err
		}},
		{"update", "memory_entries", "UPDATE", func(s *Store, id string) error {
			_, err := s.Update(t.Context(), id, EntryPatch{"text": []byte(`"replacement"`)})
			return err
		}},
		{"confirm", "memory_entries", "UPDATE", func(s *Store, id string) error { _, err := s.Confirm(t.Context(), id, false); return err }},
		{"delete", "memory_entries", "DELETE", func(s *Store, id string) error { _, err := s.Delete(t.Context(), id); return err }},
		{"note", "notes", "UPDATE", func(s *Store, _ string) error { return s.WriteNote(t.Context(), "identity.md", "replacement") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := openStoreFixture(t)
			entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Original remembered preference", Source: Source{Kind: "user"}})
			if err != nil {
				t.Fatal(err)
			}
			before, err := s.ManagementSnapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", s.DatabaseFile())
			if err != nil {
				t.Fatal(err)
			}
			// This additional fixture trigger preserves the real schema and
			// executes the real SQL path, while failing the intended write.
			_, err = db.Exec("CREATE TRIGGER isolated_write_failure BEFORE " + test.action + " ON " + test.table + " BEGIN SELECT RAISE(ABORT,'private-fixture-cause'); END")
			if err != nil {
				db.Close()
				t.Fatal(err)
			}
			db.Close()
			if err := test.write(s, entry.ID); err == nil || strings.Contains(err.Error(), "private-fixture-cause") {
				t.Fatal("SQL write failure was reported as saved or exposed raw causes", err)
			}
			after, err := s.ManagementSnapshot(t.Context())
			if err != nil || len(after.Entries) != 1 || after.Entries[0].Text != entry.Text || after.Entries[0].Status != entry.Status || after.Entries[0].UpdatedAt != entry.UpdatedAt {
				t.Fatal("failed SQL operation changed committed entry", err)
			}
			for index := range before.Notes {
				if before.Notes[index] != after.Notes[index] {
					t.Fatal("failed note mutation changed committed content")
				}
			}
		})
	}
}
