package memory

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMarkdownBackupPreservesOnlyExistingRawNotesAndExportsMissingDefaults(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dir := filepath.Join(root, "memory", "dant")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	original := "Legacy password=fixture-secret"
	if err := os.WriteFile(filepath.Join(dir, "identity.md"), []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(ctx, root, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	backups, _ := filepath.Glob(filepath.Join(dir, "markdown-backup-*"))
	if len(backups) != 1 {
		t.Fatal("missing backup")
	}
	files, err := os.ReadDir(backups[0])
	if err != nil || len(files) != 1 || files[0].Name() != "identity.md" {
		t.Fatal("backup invented source files")
	}
	raw, err := os.ReadFile(filepath.Join(backups[0], "identity.md"))
	if err != nil || string(raw) != original {
		t.Fatal("backup altered original authored bytes")
	}
	for _, name := range []string{"README.md", "working-memory.md"} {
		if _, err = os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal("missing export snapshot", err)
		}
	}
	if text, err := s.ReadNote(ctx, "identity.md"); err != nil || strings.Contains(text, "fixture-secret") {
		t.Fatal("authority did not sanitize imported note")
	}
}

func TestContextCacheIsRevisionBoundAndCandidateContentNeverAppears(t *testing.T) {
	ctx := context.Background()
	s := openStoreFixture(t)
	if _, err := s.Propose(ctx, Proposal{Kind: "semantic", Text: "Unconfirmed confidential inference", Source: Source{Kind: "inference"}}); err != nil {
		t.Fatal(err)
	}
	first, err := s.Context(ctx, true)
	if err != nil || strings.Contains(first, "Unconfirmed") {
		t.Fatal("candidate injected")
	}
	cached := s.contextCache
	if second, err := s.Context(ctx, true); err != nil || second != first || s.contextCache != cached {
		t.Fatal("unchanged revision rebuilt cache")
	}
	db, err := sql.Open("sqlite", s.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE notes SET text='Externally committed fact' WHERE name='working-memory.md'"); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	changed, err := s.Context(ctx, true)
	if err != nil || !strings.Contains(changed, "Externally committed fact") || s.contextCache == cached {
		t.Fatal("stale context cache survived durable revision")
	}
	if _, err = s.Context(ctx, false); err != nil || s.contextCache.includeEntries {
		t.Fatal("includeEntries cache key lost")
	}
}

func TestProjectMigrationValidatesEntireBatchBeforeWritingAndRetainsLegacyUTF16(t *testing.T) {
	ctx := context.Background()
	s := openStoreFixture(t)
	raw := json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"m","at":1000,"text":"needle\ud800tail","attachments":[]},"humanUpdates":[],"results":[]}`)
	var valid contracts.RawObject
	_ = json.Unmarshal(raw, &valid)
	records := []contracts.WorkRecord{{ID: "first", Status: contracts.WorkStatusPaused, ProjectContext: valid}, {ID: "bad", Status: contracts.WorkStatusPaused, ProjectContext: contracts.RawObject{"version": json.RawMessage("99")}}}
	if err := s.MigrateProjects(ctx, "conv", records); err == nil {
		t.Fatal("invalid later record accepted")
	}
	if project, err := s.ReadProject(ctx, "conv", "first"); err != nil || project != nil {
		t.Fatal("partial import survived failed validation")
	}
	if err := s.MigrateProjects(ctx, "conv", records[:1]); err != nil {
		t.Fatal(err)
	}
	project, err := s.ReadProject(ctx, "conv", "first")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := marshalJS(project)
	if err != nil || !bytes.Contains(encoded, []byte(`\ud800`)) {
		t.Fatal("legacy surrogate silently rewritten")
	}
	refs, err := s.Retrieve(ctx, "needle", Scope{ConversationID: "conv", WorkID: ptr("first")}, RetrieveOptions{Limit: 6})
	if err != nil || len(refs) != 1 {
		t.Fatal("legacy project could not be recalled", err)
	}
	encoded, _ = json.Marshal(refs[0].Text)
	if !bytes.Contains(encoded, []byte(`\ud800`)) {
		t.Fatal("retrieval replaced authored UTF16")
	}
	project.OriginalRequest.Text = "Explicit replacement"
	encoded, _ = marshalJS(project)
	if bytes.Contains(encoded, []byte(`\ud800`)) {
		t.Fatal("old raw text resurrected after explicit change")
	}
}

func TestBackupValidationNeverInitializesAndColumnDriftStopsWriter(t *testing.T) {
	ctx := context.Background()
	s := openStoreFixture(t)
	before, err := os.ReadFile(s.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateBackupDatabase(ctx, s.DatabaseFile()); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(s.DatabaseFile())
	if !bytes.Equal(before, after) {
		t.Fatal("read-only validation changed database")
	}
	empty := filepath.Join(t.TempDir(), "empty.sqlite")
	if err = os.WriteFile(empty, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err = ValidateBackupDatabase(ctx, empty); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("empty database was initialized")
	}
	db, err := sql.Open("sqlite", s.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("ALTER TABLE notes ADD COLUMN extra TEXT"); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	if err = s.WriteNote(ctx, "identity.md", "Must not commit"); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("column drift was ignored", err)
	}
}
