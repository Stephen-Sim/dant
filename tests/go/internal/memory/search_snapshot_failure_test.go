package memory

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestSearchRejectsCorruptIndexMetadataAndOmitsMissingOrUnconfirmedDocuments(t *testing.T) {
	for _, kind := range []string{"invalid note", "scoped note", "timestamped note", "missing note", "unknown kind", "missing entry", "candidate entry", "missing project", "project timestamp", "project scope"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "needle remembered fact", Source: Source{Kind: "user"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.WriteProject(t.Context(), "conversation", "project", []byte(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"needle project","attachments":[]},"humanUpdates":[],"results":[]}`)); err != nil {
				t.Fatal(err)
			}
			// Build a real index, then emulate a stale or corrupt persisted
			// index without changing the authoritative document revision.
			if _, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); err != nil {
				t.Fatal(err)
			}
			id, documentKind := "identity.md", "note"
			var conversation, work, updated any
			wantError := true
			switch kind {
			case "invalid note":
				id = "unrecognized.md"
			case "scoped note":
				conversation = "conversation"
			case "timestamped note":
				updated = 1000
			case "missing note":
				memoryFixtureSQL(t, s, "DELETE FROM notes WHERE name='identity.md'")
				wantError = false
			case "unknown kind":
				documentKind = "foreign"
			case "missing entry":
				id, documentKind, updated, wantError = "missing", "semantic", 1000, false
			case "candidate entry":
				id, documentKind, updated, wantError = entry.ID, entry.Kind, entry.UpdatedAt, false
			case "missing project":
				id, documentKind, conversation, work, updated, wantError = "missing", "project", "conversation", "missing", 1000, false
			case "project timestamp":
				id, documentKind, conversation, work, updated = "project", "project", "conversation", "project", 2000
			case "project scope":
				id, documentKind, conversation, work, updated = "project", "project", "conversation", "other", 1000
			}
			memoryFixtureSQL(t, s, "DELETE FROM memory_search;UPDATE memory_meta SET search_revision=revision")
			memoryFixtureSQL(t, s, "INSERT INTO memory_search(document_key,kind,text,updated_at,conversation_id,work_id) VALUES(?,?,?,?,?,?)", id, documentKind, "needle", updated, conversation, work)
			result, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10})
			if wantError {
				if !errors.Is(err, ErrInvalidSnapshot) || len(result) != 0 {
					t.Fatal("corrupt index metadata yielded a reference", kind, err)
				}
			} else if err != nil || len(result) != 0 {
				t.Fatal("missing or unconfirmed content became searchable", kind, err)
			}
			if !wantError {
				refs, err := s.Retrieve(t.Context(), "needle", Scope{ConversationID: "conversation", WorkID: ptr("missing")}, RetrieveOptions{Limit: 6})
				if err != nil || len(refs) != 0 {
					t.Fatal("missing or unconfirmed content entered fresh recall", kind, err)
				}
			}
		})
	}
}

func TestSearchRepositoryRefusesChangedRevisionsAndClosedTransactions(t *testing.T) {
	s := openStoreFixture(t)
	if _, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", s.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var revision int64
	if err := db.QueryRow("SELECT revision FROM memory_meta").Scan(&revision); err != nil {
		t.Fatal(err)
	}
	r := &repository{db: db, revision: revision}
	for _, test := range []struct {
		name, statement string
		want            error
	}{
		{"stale reader", "UPDATE memory_meta SET revision=revision+1,search_revision=revision+1", ErrStaleSnapshot},
		{"unindexed revision", "UPDATE memory_meta SET search_revision=-1", ErrInvalidSnapshot},
		{"missing revision", "DELETE FROM memory_meta", ErrInvalidSnapshot},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := db.Exec(test.statement); err != nil {
				t.Fatal(err)
			}
			called := false
			err := r.read(t.Context(), func(*sql.Tx) error { called = true; return nil })
			if !errors.Is(err, test.want) || called {
				t.Fatal("unconfirmed snapshot reached the reader", err)
			}
		})
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := r.read(t.Context(), func(*sql.Tx) error { t.Fatal("closed database reached operation"); return nil }); !errors.Is(err, ErrUnavailable) {
		t.Fatal("closed database was not classified", err)
	}
}

func TestSourceAndTextDecodingRetainEscapesAndRejectInvalidUntrustedFields(t *testing.T) {
	for _, raw := range []string{strings.Repeat("x", maxSourceBytes+1), "null", "[]", "{", `{"kind":"user","messageId":""}`, `{"kind":"user","at":0}`, `{"kind":"user","at":1.5}`} {
		if _, err := parseSource(raw); !errors.Is(err, ErrInvalidSnapshot) {
			t.Fatal("invalid source metadata accepted", err)
		}
	}
	source, err := parseSource(`{"kind":"task","conversationId":"conversation","workId":"work","messageId":"message","at":1000}`)
	if err != nil || source.MessageID == nil || *source.MessageID != "message" || source.At == nil || *source.At != 1000 {
		t.Fatal("source identity or timestamp omitted", err)
	}
	var text Text
	if err := text.UnmarshalJSON([]byte(`"\"\\\/\b\f\n\r\t\ud800"`)); err != nil || text.UTF16Length() != 9 {
		t.Fatal("authored JSON escapes were not preserved", err)
	}
	for _, raw := range [][]byte{[]byte("null"), []byte(`"\q"`), []byte{'"', 0xff, '"'}, []byte(`"\uZZZZ"`)} {
		if err := text.UnmarshalJSON(raw); !errors.Is(err, ErrInvalidMemory) {
			t.Fatal("invalid text was accepted", err)
		}
	}
	s := openStoreFixture(t)
	if _, err := s.Entries(t.Context(), contracts.MemoryEntryStatus("unknown")); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid status entered a query", err)
	}
}
