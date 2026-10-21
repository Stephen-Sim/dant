package memory

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestSearchAndRecallRefuseMissingOrNonFTSIndexesWithoutPartialReferences(t *testing.T) {
	for _, shape := range []string{"missing index", "ordinary table"} {
		t.Run(shape, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "Synthetic needle identity"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); err != nil {
				t.Fatal(err)
			}
			memoryFixtureSQL(t, s, "DROP TABLE memory_search")
			if shape == "ordinary table" {
				memoryFixtureSQL(t, s, `CREATE TABLE memory_search(document_key,kind,text,updated_at,conversation_id,work_id)`)
			}

			for _, retrieval := range []bool{false, true} {
				var err error
				if retrieval {
					var references []Reference
					references, err = s.Retrieve(t.Context(), "needle", Scope{ConversationID: "isolated-conversation"}, RetrieveOptions{Limit: 6})
					if len(references) != 0 {
						t.Fatal("damaged index yielded partial recall")
					}
				} else {
					var results []SearchResult
					results, err = s.Search(t.Context(), "needle", SearchOptions{Limit: 10})
					if len(results) != 0 {
						t.Fatal("damaged index yielded partial search results")
					}
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Fatal("damaged FTS index lost its classified failure", err)
				}
			}

			text, err := s.ReadNote(t.Context(), "identity.md")
			if err != nil || text != "Synthetic needle identity" {
				t.Fatal("failed index read changed canonical memory", err)
			}
		})
	}
}

func TestSearchIndexRebuildFailureRollsBackItsPreviousRowsAndRevision(t *testing.T) {
	for _, rejectedKind := range []string{"note", "project", "semantic"} {
		t.Run(rejectedKind, func(t *testing.T) {
			s := openStoreFixture(t)
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

			memoryFixtureSQL(t, s, "DROP TABLE memory_search")
			// Keep all authoritative tables and triggers intact. This isolated
			// damaged index rejects exactly one document kind during rebuild.
			memoryFixtureSQL(t, s, `CREATE TABLE memory_search(document_key,kind,text,updated_at,conversation_id,work_id,CHECK(kind <> '`+rejectedKind+`'))`)
			memoryFixtureSQL(t, s, `INSERT INTO memory_search(document_key,kind,text) VALUES('retained-index-row','retained','previous index')`)
			memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=-1")

			if results, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); !errors.Is(err, ErrUnavailable) || len(results) != 0 || strings.Contains(err.Error(), "CHECK") {
				t.Fatal("failed index rebuild returned results or exposed SQLite details", err)
			}
			var retained, indexed int
			err = s.connection(t.Context(), func(db *sql.DB) error {
				if err := db.QueryRowContext(t.Context(), "SELECT count(*) FROM memory_search WHERE document_key='retained-index-row'").Scan(&retained); err != nil {
					return err
				}
				return db.QueryRowContext(t.Context(), "SELECT search_revision FROM memory_meta WHERE id=1").Scan(&indexed)
			})
			if err != nil || retained != 1 || indexed != -1 {
				t.Fatal("failed rebuild discarded the last index or advanced its revision", err)
			}
			entries, err := s.Entries(t.Context(), contracts.MemoryEntryStatusConfirmed)
			if err != nil || len(entries) != 1 || entries[0].ID != entry.ID || entries[0].Text != entry.Text {
				t.Fatal("index rebuild failure changed canonical confirmed memory", err)
			}
		})
	}
}

func TestPreparedRecallScopeAndEmptyQueryValidationRemainBounded(t *testing.T) {
	f := newFixture(t)
	if _, err := f.reader.Search(t.Context(), PreparedQuery{Terms: []string{"needle"}}, SearchOptions{Limit: 1, ConversationID: ptr("invalid scope")}); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("prepared search accepted a malformed conversation scope", err)
	}
	for _, limit := range []int{0, DefaultRetrieveLimit + 1} {
		if _, err := f.reader.Retrieve(t.Context(), PreparedQuery{Terms: []string{"needle"}}, Scope{ConversationID: "conversation"}, RetrieveOptions{Limit: limit}); !errors.Is(err, ErrInvalidLimit) {
			t.Fatal("prepared recall accepted an invalid result limit", err)
		}
	}
	if references, err := f.reader.Retrieve(t.Context(), PreparedQuery{}, Scope{ConversationID: "conversation"}, RetrieveOptions{Limit: DefaultRetrieveLimit}); err != nil || len(references) != 0 {
		t.Fatal("empty prepared recall invented references", err)
	}
	if entries, err := f.store.Entries(t.Context(), contracts.MemoryEntryStatusConfirmed); err != nil || len(entries) != 0 {
		t.Fatal("query validation changed durable memory", err)
	}
}
