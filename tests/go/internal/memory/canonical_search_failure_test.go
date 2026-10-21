package memory

import (
	"database/sql"
	"errors"
	"testing"
)

func TestMemorySearchRejectsCorruptCanonicalDocumentsAndCandidateIdentities(t *testing.T) {
	for _, shape := range []string{"invalid index identity", "invalid canonical note", "missing canonical note", "invalid confirmed source", "invalid project rebuild", "invalid project read"} {
		t.Run(shape, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "Synthetic needle identity"); err != nil {
				t.Fatal(err)
			}
			entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Synthetic needle fact", Source: Source{Kind: "user"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Confirm(t.Context(), entry.ID, false); err != nil {
				t.Fatal(err)
			}
			if _, err := s.WriteProject(t.Context(), "conversation", "work", []byte(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"Synthetic needle project","attachments":[]},"humanUpdates":[],"results":[]}`)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); err != nil {
				t.Fatal(err)
			}
			want := ErrInvalidSnapshot
			switch shape {
			case "invalid index identity":
				memoryFixtureSQL(t, s, "UPDATE memory_search SET document_key='invalid identity' WHERE kind='note'")
			case "invalid canonical note":
				memoryFixtureSQL(t, s, "UPDATE notes SET text=? WHERE name='identity.md'", "Synthetic needle\x00identity")
				memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=revision WHERE id=1")
			case "missing canonical note":
				memoryFixtureSQL(t, s, "DELETE FROM notes WHERE name='identity.md'")
			case "invalid confirmed source":
				memoryFixtureSQL(t, s, "UPDATE memory_entries SET source_json='{' WHERE id=?", entry.ID)
			case "invalid project rebuild", "invalid project read":
				want = ErrInvalidMemory
				memoryFixtureSQL(t, s, "UPDATE projects SET context_json='{' WHERE conversation_id='conversation' AND work_id='work'")
				if shape == "invalid project read" {
					want = ErrUnavailable
					memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=revision WHERE id=1")
				}
			}

			results, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10})
			if !errors.Is(err, want) || len(results) != 0 {
				t.Fatal("corrupt memory yielded partial trusted references", err)
			}
		})
	}
}

func TestIndexDeletionFailurePreservesTheLastPersistedIndexRows(t *testing.T) {
	s := openStoreFixture(t)
	memoryFixtureSQL(t, s, "DROP TABLE memory_search")
	memoryFixtureSQL(t, s, `CREATE TABLE memory_search(document_key,kind,text,updated_at,conversation_id,work_id)`)
	memoryFixtureSQL(t, s, `INSERT INTO memory_search(document_key,kind,text) VALUES('retained','retained','Synthetic retained index')`)
	memoryFixtureSQL(t, s, `CREATE TRIGGER isolated_delete_failure BEFORE DELETE ON memory_search BEGIN SELECT RAISE(ABORT,'private fixture index failure'); END`)
	memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=-1 WHERE id=1")
	if results, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); !errors.Is(err, ErrUnavailable) || len(results) != 0 {
		t.Fatal("failed index replacement returned trusted references", err)
	}
	var count int
	if err := s.connection(t.Context(), func(db *sql.DB) error {
		return db.QueryRowContext(t.Context(), "SELECT count(*) FROM memory_search WHERE document_key='retained'").Scan(&count)
	}); err != nil || count != 1 {
		t.Fatal("failed index replacement deleted its previous committed rows", err)
	}
}

func TestManagementSQLFailuresCannotPartiallyEditOrDeleteMemory(t *testing.T) {
	for _, action := range []string{"note update", "entry update", "entry delete", "entry confirm", "invalid stored entry"} {
		t.Run(action, func(t *testing.T) {
			s := openStoreFixture(t)
			entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Synthetic retained preference", Source: Source{Kind: "user"}})
			if err != nil {
				t.Fatal(err)
			}
			mutation := Mutation{Kind: entry.Kind, ID: entry.ID, Action: "update", Text: ptr("Synthetic replacement preference")}
			if action == "invalid stored entry" {
				memoryFixtureSQL(t, s, "UPDATE memory_entries SET source_json='{' WHERE id=?", entry.ID)
			} else {
				operation, table := "UPDATE", "memory_entries"
				if action == "entry delete" {
					operation, mutation.Action = "DELETE", "delete"
				} else if action == "entry confirm" {
					mutation.Action = "confirm"
				} else if action == "note update" {
					table, mutation.Kind, mutation.ID = "notes", "note", "identity.md"
				}
				memoryFixtureSQL(t, s, "CREATE TRIGGER isolated_manage_failure BEFORE "+operation+" ON "+table+" BEGIN SELECT RAISE(ABORT,'private fixture management failure'); END")
			}
			if err := s.transaction(t.Context(), false, func(tx *sql.Tx) error {
				mutation.Revision, err = revisionString(t.Context(), tx)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Manage(t.Context(), mutation); err == nil {
				t.Fatal("failed management mutation reported a successful revision")
			}
			var text, status string
			if err := s.connection(t.Context(), func(db *sql.DB) error {
				return db.QueryRowContext(t.Context(), "SELECT text,status FROM memory_entries WHERE id=?", entry.ID).Scan(&text, &status)
			}); err != nil || text != entry.Text || status != string(entry.Status) {
				t.Fatal("failed management mutation changed committed memory", err)
			}
		})
	}
}
