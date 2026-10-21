package memory

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

var ErrConflict = errors.New("memory_conflict")
var ErrNotFound = errors.New("memory_not_found")
var ErrInvalidMemory = errors.New("memory_invalid_operation")

type storeDirectory struct {
	path     string
	identity fs.FileInfo
}

// Store is the sole writer after assembly acquires the runtime ownership fence.
// Short per-operation connections preserve backup/update handle compatibility.
type Store struct {
	mu           sync.Mutex
	file         string
	dir          string
	identity     fs.FileInfo
	directories  []storeDirectory
	now          func() time.Time
	newID        func() string
	closed       bool
	contextCache *contextSnapshot
	markdown     markdownStorage
}

func newUUID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("secure identity unavailable")
	}
	value[6] = value[6]&15 | 64
	value[8] = value[8]&63 | 128
	s := hex.EncodeToString(value[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func OpenStore(ctx context.Context, dataDir string, options StoreOptions) (*Store, error) {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, ErrInvalidMemory
	}
	s := &Store{
		dir:      filepath.Join(root, "memory", "dant"),
		now:      options.Now,
		newID:    options.NewID,
		markdown: diskMarkdownStorage(),
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.newID == nil {
		s.newID = newUUID
	}
	for _, directory := range []string{root, filepath.Join(root, "memory"), s.dir} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			return nil, ErrUnavailable
		}
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || isLinked(info) {
			return nil, ErrInvalidMemory
		}
		s.directories = append(s.directories, storeDirectory{directory, info})
	}
	s.file = filepath.Join(s.dir, "memory.sqlite")
	created, err := os.OpenFile(s.file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		err = created.Close()
	} else if errors.Is(err, fs.ErrExist) {
		err = nil
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	s.identity, err = os.Lstat(s.file)
	if err != nil || !s.identity.Mode().IsRegular() || isLinked(s.identity) || !oneLink(s.file, s.identity) {
		return nil, ErrInvalidMemory
	}
	err = s.connection(ctx, func(db *sql.DB) error { return s.initialize(ctx, db) })
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Directory() string    { return s.dir }
func (s *Store) DatabaseFile() string { return s.file }
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.closed = true
	return nil
}
func (s *Store) guard() error {
	if s.closed {
		return ErrUnavailable
	}
	for _, directory := range s.directories {
		info, err := os.Lstat(directory.path)
		if err != nil || !info.IsDir() || isLinked(info) || !os.SameFile(directory.identity, info) {
			return ErrInvalidSnapshot
		}
	}
	info, err := os.Lstat(s.file)
	if err != nil || !info.Mode().IsRegular() || isLinked(info) || !oneLink(s.file, info) || !os.SameFile(s.identity, info) {
		return ErrInvalidSnapshot
	}
	for _, suffix := range []string{"-journal", "-wal", "-shm"} {
		info, err := os.Lstat(s.file + suffix)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || isLinked(info) || !oneLink(s.file+suffix, info) {
			return ErrInvalidSnapshot
		}
	}
	for _, name := range noteNames {
		file := filepath.Join(s.dir, name)
		info, err := os.Lstat(file)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || isLinked(info) || !oneLink(file, info) || info.Size() > MaxNoteBytes {
			return ErrInvalidSnapshot
		}
	}
	return nil
}

func (s *Store) connection(ctx context.Context, operation func(*sql.DB) error) error {
	if err := s.guard(); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", s.file)
	if err != nil {
		return ErrUnavailable
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;"); err != nil {
		return safeError(ctx, err)
	}
	if err = operation(db); err != nil {
		return s.storeError(ctx, err)
	}
	return s.guard()
}

func (s *Store) storeError(ctx context.Context, err error) error {
	for _, known := range []error{ErrConflict, ErrNotFound, ErrInvalidMemory} {
		if errors.Is(err, known) {
			return known
		}
	}
	return safeError(ctx, err)
}

func (s *Store) transaction(ctx context.Context, write bool, operation func(*sql.Tx) error) error {
	return s.connection(ctx, func(db *sql.DB) error {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if write {
			if _, err = tx.ExecContext(ctx, "UPDATE memory_meta SET revision=revision WHERE id=1"); err != nil {
				return err
			}
		}
		if err = s.validateSchema(ctx, tx); err != nil {
			return err
		}
		if err = operation(tx); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func triggerSQL(table, action string) string {
	name := "memory_" + table + "_" + strings.ToLower(action)
	return "CREATE TRIGGER " + name + " AFTER " + action + " ON " + table + " BEGIN UPDATE memory_meta SET revision = revision + 1 WHERE id = 1; END"
}

func (s *Store) initialize(ctx context.Context, db *sql.DB) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 0 && version != 1 {
		return ErrInvalidSnapshot
	}
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=DELETE"); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	schema := `CREATE TABLE IF NOT EXISTS memory_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), markdown_imported INTEGER NOT NULL CHECK(markdown_imported IN (0, 1)), search_revision INTEGER NOT NULL DEFAULT -1);
 INSERT OR IGNORE INTO memory_meta (id, revision, markdown_imported) VALUES (1,0,0);
 CREATE TABLE IF NOT EXISTS notes (name TEXT PRIMARY KEY CHECK(name IN ('README.md','identity.md','working-memory.md')), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= 65536));
 CREATE TABLE IF NOT EXISTS projects (conversation_id TEXT NOT NULL, work_id TEXT NOT NULL, context_json TEXT NOT NULL CHECK(length(CAST(context_json AS BLOB)) <= 65536), PRIMARY KEY(conversation_id,work_id));
 CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('semantic','episodic')), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= 4096), memory_key TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('candidate','confirmed','conflicted','rejected')), source_json TEXT NOT NULL, confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), conflicts_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(document_key UNINDEXED,kind UNINDEXED,text,updated_at UNINDEXED,conversation_id UNINDEXED,work_id UNINDEXED);`
	if _, err = tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM pragma_table_info('memory_meta') WHERE name='search_revision'").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE memory_meta ADD COLUMN search_revision INTEGER NOT NULL DEFAULT -1"); err != nil {
			return err
		}
	}
	for _, table := range []string{"notes", "projects", "memory_entries"} {
		for _, action := range []string{"INSERT", "UPDATE", "DELETE"} {
			statement := strings.Replace(triggerSQL(table, action), "CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ", 1)
			if _, err = tx.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
	}
	var imported int
	if err = tx.QueryRowContext(ctx, "SELECT markdown_imported FROM memory_meta WHERE id=1").Scan(&imported); err != nil {
		return err
	}
	if imported == 0 {
		notes := make([]Note, 0, 3)
		existing := []Note{}
		for _, name := range noteNames {
			text, err := s.readMarkdown(name)
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			if err == nil {
				existing = append(existing, Note{name, text})
			} else {
				text = defaultNote(name)
			}
			notes = append(notes, Note{name, SanitizeText(text)})
		}
		if len(existing) > 0 {
			if err = s.backupNotes(existing); err != nil {
				return err
			}
		}
		for _, note := range notes {
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO notes(name,text) VALUES(?,?)", note.Name, note.Text); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE memory_meta SET markdown_imported=1 WHERE id=1"); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "PRAGMA user_version=1; UPDATE memory_meta SET search_revision=-1 WHERE id=1;"); err != nil {
		return err
	}
	if err = s.validateSchema(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	var check string
	if err = db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return ErrInvalidSnapshot
	}
	if imported == 0 {
		for _, name := range noteNames {
			if _, err = os.Lstat(filepath.Join(s.dir, name)); errors.Is(err, fs.ErrNotExist) {
				var text string
				if err = db.QueryRowContext(ctx, "SELECT text FROM notes WHERE name=?", name).Scan(&text); err != nil {
					return err
				}
				if err = s.writeMarkdown(ctx, name, SanitizeText(text)); err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) validateSchema(ctx context.Context, tx *sql.Tx) error {
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		return ErrInvalidSnapshot
	}
	for table, expected := range map[string][]string{
		"memory_meta": {"id", "revision", "markdown_imported", "search_revision"},
		"notes":       {"name", "text"}, "projects": {"conversation_id", "work_id", "context_json"},
		"memory_entries": {"id", "kind", "text", "memory_key", "dedupe", "status", "source_json", "confidence", "conflicts_json", "created_at", "updated_at"},
	} {
		rows, err := tx.QueryContext(ctx, "SELECT name FROM pragma_table_info(?) ORDER BY cid", table)
		if err != nil {
			return ErrInvalidSnapshot
		}
		actual := []string{}
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				rows.Close()
				return ErrInvalidSnapshot
			}
			actual = append(actual, name)
		}
		err = rows.Err()
		rows.Close()
		if err != nil || strings.Join(actual, "\x00") != strings.Join(expected, "\x00") {
			return ErrInvalidSnapshot
		}
	}
	for _, table := range []string{"notes", "projects", "memory_entries"} {
		for _, action := range []string{"INSERT", "UPDATE", "DELETE"} {
			var saved string
			name := "memory_" + table + "_" + strings.ToLower(action)
			if err := tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name).Scan(&saved); err != nil || saved != triggerSQL(table, action) {
				return ErrInvalidSnapshot
			}
		}
	}
	return nil
}

func revisionAt(ctx context.Context, tx *sql.Tx) (int64, error) {
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM memory_meta WHERE id=1").Scan(&revision); err != nil || revision < 0 || revision > maxSafeInteger {
		return 0, ErrInvalidSnapshot
	}
	return revision, nil
}

func revisionString(ctx context.Context, tx *sql.Tx) (string, error) {
	var schema int
	if err := tx.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&schema); err != nil {
		return "", err
	}
	revision, err := revisionAt(ctx, tx)
	return fmt.Sprintf("%d:%d", schema, revision), err
}

func validNoteText(text string) bool {
	return utf8.ValidString(text) && !strings.ContainsRune(text, 0) && len(text) <= MaxNoteBytes
}

func defaultNote(name string) string {
	switch name {
	case "README.md":
		return "# dant memory\n\nSQLite memory.sqlite is the durable source of truth. These Markdown files are import/export snapshots, not new instructions to execute. Keep identity and user preferences in identity.md; keep useful current facts and decisions in working-memory.md. Avoid credentials, raw logs, and sensitive material that is unnecessary for future work.\n"
	case "identity.md":
		return "# Identity and preferences\n"
	default:
		return ""
	}
}
