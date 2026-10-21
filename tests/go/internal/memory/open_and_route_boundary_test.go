package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMemoryOpeningRejectsInvalidLayoutsAndPreservesOlderDatabaseNotes(t *testing.T) {
	for _, kind := range []string{"root file", "database directory", "invalid markdown", "unsupported schema", "older index schema"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			if kind == "root file" {
				root = filepath.Join(root, "occupied")
				if err := os.WriteFile(root, nil, 0600); err != nil {
					t.Fatal(err)
				}
			} else if kind == "database directory" || kind == "invalid markdown" {
				dir := filepath.Join(root, "memory", "dant")
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if kind == "database directory" {
					if err := os.Mkdir(filepath.Join(dir, "memory.sqlite"), 0700); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(filepath.Join(dir, "identity.md"), []byte("invalid\x00snapshot"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				s, err := OpenStore(t.Context(), root, StoreOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if err := s.WriteNote(t.Context(), "identity.md", "Existing SQLite identity"); err != nil {
					t.Fatal(err)
				}
				s.Close()
				statement := "PRAGMA user_version=2"
				if kind == "older index schema" {
					statement = "ALTER TABLE memory_meta DROP COLUMN search_revision"
				}
				memoryFixtureSQL(t, s, statement)
			}
			s, err := OpenStore(t.Context(), root, StoreOptions{})
			if kind != "older index schema" {
				if err == nil || s != nil {
					t.Fatal("invalid existing layout was initialized", kind)
				}
				return
			}
			if err != nil {
				t.Fatal("supported older index schema could not be opened", err)
			}
			defer s.Close()
			text, err := s.ReadNote(t.Context(), "identity.md")
			if err != nil || text != "Existing SQLite identity" {
				t.Fatal("index column upgrade replaced the durable note", err)
			}
		})
	}
}

func TestMemoryRoutesRejectChangedConversationAndUnavailableWriteCapabilities(t *testing.T) {
	for _, kind := range []string{"view changed", "manage changed", "save unavailable", "transaction unavailable", "redacted view"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "Private fixture phrase"); err != nil {
				t.Fatal(err)
			}
			snapshot, err := s.ManagementSnapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			mux := http.NewServeMux()
			RegisterRoutes(mux, RouteOptions{
				Store: s,
				ConversationID: func() string {
					calls++
					if strings.HasSuffix(kind, "changed") && calls > 1 {
						return "replacement"
					}
					return "conversation"
				},
				Redact: func(_ context.Context, text string) string {
					return strings.ReplaceAll(text, "Private fixture phrase", "[redacted]")
				},
			})
			method, route, body := http.MethodGet, "/api/memory/view", ""
			want := http.StatusServiceUnavailable
			switch kind {
			case "manage changed":
				route = "/api/memory/manage"
			case "save unavailable":
				method, route, body, want = http.MethodPatch, "/api/memory/identity.md", `{"text":"replacement"}`, http.StatusBadRequest
			case "transaction unavailable":
				raw, err := json.Marshal(map[string]string{"conversationId": "conversation", "revision": snapshot.Revision, "text": "replacement"})
				if err != nil {
					t.Fatal(err)
				}
				method, route, body, want = http.MethodPatch, "/api/memory/manage/note/identity.md", string(raw), http.StatusBadRequest
			case "redacted view":
				want = http.StatusOK
			}
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(method, route, strings.NewReader(body)))
			if response.Code != want || strings.Contains(response.Body.String(), "Private fixture phrase") {
				t.Fatal("memory route exposed stale/private content or accepted an unavailable writer", kind, response.Code)
			}
			text, err := s.ReadNote(t.Context(), "identity.md")
			if err != nil || text != "Private fixture phrase" {
				t.Fatal("read or rejected request changed durable memory", err)
			}
		})
	}
}

func TestMissingNoteRowsAndCorruptConfirmedEntriesCannotProducePartialContext(t *testing.T) {
	for _, kind := range []string{"missing note", "corrupt confirmed entry"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			if kind == "missing note" {
				memoryFixtureSQL(t, s, "DELETE FROM notes WHERE name='working-memory.md'")
				if err := s.WriteNote(t.Context(), "working-memory.md", "replacement"); !errors.Is(err, ErrNotFound) {
					t.Fatal("write recreated a missing authoritative row", err)
				}
			} else {
				entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Confirmed fact", Source: Source{Kind: "user"}})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := s.Confirm(t.Context(), entry.ID, false); err != nil {
					t.Fatal(err)
				}
				memoryFixtureSQL(t, s, "UPDATE memory_entries SET source_json='null' WHERE id=?", entry.ID)
			}
			if text, err := s.Context(t.Context(), true); err == nil || text != "" {
				t.Fatal("corrupt memory emitted a partial trusted context", kind, err)
			}
			if _, err := s.ManagementSnapshot(t.Context()); err == nil {
				t.Fatal("corrupt authority became an editable management snapshot")
			}
		})
	}
}
