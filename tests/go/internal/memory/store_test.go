package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func openStoreFixture(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(context.Background(), t.TempDir(), StoreOptions{Now: func() time.Time { return time.UnixMilli(1760000000000) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestWriterPersistsNotesEntriesConflictAndRetrievalAtExistingPaths(t *testing.T) {
	ctx := context.Background()
	store := openStoreFixture(t)
	if filepath.Base(store.DatabaseFile()) != "memory.sqlite" || filepath.Base(store.Directory()) != "dant" {
		t.Fatal("persisted names changed")
	}
	if err := store.WriteNote(ctx, "identity.md", "Prefers TypeScript; api_key=fixture-sensitive-value"); err != nil {
		t.Fatal(err)
	}
	text, err := store.ReadNote(ctx, "identity.md")
	if err != nil || strings.Contains(text, "fixture-sensitive-value") || !strings.Contains(text, sensitiveOmitted) {
		t.Fatal("note redaction failed", err)
	}
	proposal := Proposal{Kind: "semantic", Text: "Renderer prefers TypeScript", Source: Source{Kind: "user"}, Confidence: ptr(0.0)}
	entry, err := store.Propose(ctx, proposal)
	if err != nil || entry.Status != contracts.MemoryEntryStatusCandidate {
		t.Fatal(err)
	}
	again, err := store.Propose(ctx, proposal)
	if err != nil || again.ID != entry.ID {
		t.Fatal("dedupe changed", err)
	}
	if _, err = store.Confirm(ctx, entry.ID, false); err != nil {
		t.Fatal(err)
	}
	key := entry.Key
	replacement, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Renderer prefers Python", Key: &key, Source: Source{Kind: "inference"}})
	if err != nil || replacement.Status != contracts.MemoryEntryStatusConflicted {
		t.Fatal("conflict not retained", err)
	}
	if _, err = store.Confirm(ctx, replacement.ID, false); !errors.Is(err, ErrConflict) {
		t.Fatal("conflict silently accepted", err)
	}
	if _, err = store.Confirm(ctx, replacement.ID, true); err != nil {
		t.Fatal(err)
	}
	refs, err := store.Retrieve(ctx, "python", Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || len(refs) != 1 || refs[0].ID != replacement.ID {
		t.Fatal("live read did not refresh FTS", err)
	}
	raw := json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"real-message","at":1000,"text":"Project lattice","attachments":[]},"humanUpdates":[],"results":[]}`)
	if _, err = store.WriteProject(ctx, "conv", "work", raw); err != nil {
		t.Fatal(err)
	}
	refs, err = store.Retrieve(ctx, "lattice", Scope{ConversationID: "conv", WorkID: ptr("work")}, RetrieveOptions{Limit: 6})
	if err != nil || len(refs) != 1 || refs[0].Kind != "project" {
		t.Fatal("project scope missing", err)
	}
	other, err := store.Retrieve(ctx, "lattice", Scope{ConversationID: "other", WorkID: ptr("work")}, RetrieveOptions{Limit: 6})
	if err != nil || len(other) != 0 {
		t.Fatal("project crossed scope", err)
	}
	root := filepath.Dir(filepath.Dir(store.Directory()))
	store.Close()
	reopened, err := OpenStore(ctx, root, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	entries, err := reopened.Entries(ctx, "")
	if err != nil || len(entries) != 2 {
		t.Fatal("durable records lost", err)
	}
}

func TestManagementUsesExactRevisionAndCandidateConfirmation(t *testing.T) {
	ctx := context.Background()
	store := openStoreFixture(t)
	snapshot, err := store.ManagementSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	text := "Known preference"
	saved, err := store.Manage(ctx, Mutation{Revision: snapshot.Revision, Kind: "note", ID: "identity.md", Action: "update", Text: &text})
	if err != nil || saved.Revision == snapshot.Revision {
		t.Fatal(err)
	}
	if _, err = store.Manage(ctx, Mutation{Revision: snapshot.Revision, Kind: "note", ID: "identity.md", Action: "delete"}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision overwrote data", err)
	}
	entry, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Project preference", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _ = store.ManagementSnapshot(ctx)
	if _, err = store.Manage(ctx, Mutation{Revision: snapshot.Revision, Kind: "semantic", ID: entry.ID, Action: "confirm"}); err != nil {
		t.Fatal(err)
	}
	changed, err := store.Delete(ctx, entry.ID)
	if err != nil || !changed {
		t.Fatal(err)
	}
	changed, err = store.Delete(ctx, entry.ID)
	if err != nil || changed {
		t.Fatal("delete invented previous existence", err)
	}
}

func TestMarkdownMigrationIsOneTimeBackedUpAndOrdinaryFileOnly(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	directory := filepath.Join(root, "memory", "dant")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "identity.md"), []byte("Legacy preference"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(ctx, root, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	text, err := store.ReadNote(ctx, "identity.md")
	if err != nil || text != "Legacy preference" {
		t.Fatal(err)
	}
	matches, _ := filepath.Glob(filepath.Join(directory, "markdown-backup-*", "identity.md"))
	if len(matches) != 1 {
		t.Fatal("legacy notes not backed up")
	}
	if err = store.WriteNote(ctx, "identity.md", "New durable preference"); err != nil {
		t.Fatal(err)
	}
	if err = store.ExportMarkdown(ctx, "identity.md"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "identity.md"), []byte("Explicit imported preference"), 0600); err != nil {
		t.Fatal(err)
	}
	text, _ = store.ReadNote(ctx, "identity.md")
	if text != "New durable preference" {
		t.Fatal("markdown became alternate authority")
	}
	if err = store.ImportMarkdown(ctx, "identity.md"); err != nil {
		t.Fatal(err)
	}
	if err = store.ExportMarkdown(ctx, "../private"); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("path escaped note allowlist", err)
	}
}

func TestWriterSerializesConcurrentMutationsAndRejectsChangedSchema(t *testing.T) {
	ctx := context.Background()
	store := openStoreFixture(t)
	var wait sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			failures <- store.WriteNote(ctx, "working-memory.md", "Concurrent reference")
		}()
	}
	wait.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	db, err := sql.Open("sqlite", store.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DROP TRIGGER memory_notes_update"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err = store.WriteNote(ctx, "identity.md", "Must not save"); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("schema tampering did not stop writer", err)
	}
}

func TestGoQueryNormalizationAndCredentialBoundaries(t *testing.T) {
	for _, test := range []struct {
		query string
		terms []string
	}{{"ＡＢＣ \"OR\" 编程语言", []string{"abc", "or", "编程", "程语", "语言"}}, {"İ", []string{"i"}}, {"api_key=fixture-secret", []string{"api_key"}}} {
		prepared, err := PrepareSearch(test.query)
		if err != nil || strings.Join(prepared.Terms, "|") != strings.Join(test.terms, "|") {
			t.Fatalf("query normalization mismatch %v", err)
		}
	}
	for _, value := range []string{"password=abc", "api_key=\"abc\ndef\"", "Bearer abcdefghijklmnopq", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"} {
		if SanitizeText(value) == value || SanitizeText(SanitizeText(value)) != SanitizeText(value) {
			t.Fatal("redaction must be effective and idempotent")
		}
	}
}
