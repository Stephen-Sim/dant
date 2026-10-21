package memory

import (
	"errors"
	"testing"
)

func TestProjectReadersRejectNullCanonicalRowsFromAnIncompleteOlderSchema(t *testing.T) {
	for _, indexed := range []bool{false, true} {
		t.Run(map[bool]string{false: "index rebuild", true: "retained index"}[indexed], func(t *testing.T) {
			s := openStoreFixture(t)
			if _, err := s.WriteProject(t.Context(), "conversation", "work", []byte(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"Synthetic needle project","attachments":[]},"humanUpdates":[],"results":[]}`)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); err != nil {
				t.Fatal(err)
			}
			// Emulate an older incomplete schema with the same named columns
			// and required revision triggers, but missing its NOT NULL check.
			memoryFixtureSQL(t, s, "DROP TABLE projects")
			memoryFixtureSQL(t, s, "CREATE TABLE projects(conversation_id TEXT,work_id TEXT,context_json TEXT,PRIMARY KEY(conversation_id,work_id))")
			for _, action := range []string{"INSERT", "UPDATE", "DELETE"} {
				memoryFixtureSQL(t, s, triggerSQL("projects", action))
			}
			memoryFixtureSQL(t, s, "INSERT INTO projects(conversation_id,work_id,context_json) VALUES('conversation','work',NULL)")
			if indexed {
				memoryFixtureSQL(t, s, "UPDATE memory_meta SET search_revision=revision WHERE id=1")
			}

			if project, err := s.ReadProject(t.Context(), "conversation", "work"); !errors.Is(err, ErrUnavailable) || project != nil {
				t.Fatal("null canonical project row became usable project context", err)
			}
			if results, err := s.Search(t.Context(), "needle", SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidSnapshot) || len(results) != 0 {
				t.Fatal("null canonical project yielded partial trusted search results", err)
			}
			if err := ValidateBackupDatabase(t.Context(), s.DatabaseFile()); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("null canonical project row passed read-only backup validation", err)
			}
		})
	}
}
