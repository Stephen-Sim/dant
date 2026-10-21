package memory

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// SQLite's mode=ro integrity checks can omit CHECK-constraint evaluation.
// Validate the same stored types and constraints explicitly without opening a
// writable connection or modifying a backup's schema, rows, or search index.
const backupConstraintViolationQuery = `SELECT
 (SELECT count(*) FROM memory_meta) <> 1 OR
 EXISTS (SELECT 1 FROM memory_meta WHERE
  typeof(id) <> 'integer' OR id <> 1 OR
  typeof(revision) <> 'integer' OR revision < 0 OR
  typeof(markdown_imported) <> 'integer' OR markdown_imported NOT IN (0,1) OR
  typeof(search_revision) <> 'integer') OR
 EXISTS (SELECT 1 FROM notes WHERE
  typeof(name) <> 'text' OR name NOT IN (?,?,?) OR
  typeof(text) <> 'text' OR length(CAST(text AS BLOB)) > ?) OR
 EXISTS (SELECT 1 FROM projects WHERE
  typeof(conversation_id) <> 'text' OR typeof(work_id) <> 'text' OR
  typeof(context_json) <> 'text' OR length(CAST(context_json AS BLOB)) > ?) OR
 EXISTS (SELECT 1 FROM memory_entries WHERE
  typeof(id) <> 'text' OR typeof(kind) <> 'text' OR kind NOT IN ('semantic','episodic') OR
  typeof(text) <> 'text' OR length(CAST(text AS BLOB)) > ? OR
  typeof(memory_key) <> 'text' OR typeof(dedupe) <> 'text' OR
  typeof(status) <> 'text' OR status NOT IN (?,?,?,?) OR
  typeof(source_json) <> 'text' OR typeof(conflicts_json) <> 'text' OR
  typeof(created_at) <> 'integer' OR typeof(updated_at) <> 'integer' OR
  confidence IS NOT NULL AND (typeof(confidence) NOT IN ('integer','real') OR confidence < 0 OR confidence > 1))`

func validateBackupConstraints(ctx context.Context, tx *sql.Tx) error {
	var violated bool
	err := tx.QueryRowContext(ctx, backupConstraintViolationQuery,
		noteNames[0], noteNames[1], noteNames[2], MaxNoteBytes, MaxNoteBytes, MaxEntryBytes,
		contracts.MemoryEntryStatusCandidate, contracts.MemoryEntryStatusConfirmed,
		contracts.MemoryEntryStatusConflicted, contracts.MemoryEntryStatusRejected,
	).Scan(&violated)
	if err != nil || violated {
		return ErrInvalidSnapshot
	}
	return nil
}

// ValidateBackupDatabase only reads an owning backup feature's private staged
// file. It never creates, migrates, imports Markdown, or updates FTS.
func ValidateBackupDatabase(ctx context.Context, file string) error {
	before, err := os.Lstat(file)
	if err != nil || !before.Mode().IsRegular() || isLinked(before) || !oneLink(file, before) {
		return ErrInvalidSnapshot
	}
	absolute, err := filepath.Abs(file)
	if err != nil {
		return ErrInvalidSnapshot
	}
	uriPath := filepath.ToSlash(absolute)
	if filepath.VolumeName(absolute) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{"mode": {"ro"}}
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return ErrInvalidSnapshot
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000;"); err != nil {
		return ErrInvalidSnapshot
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ErrInvalidSnapshot
	}
	defer tx.Rollback()
	if err = (&Store{}).validateSchema(ctx, tx); err != nil {
		return err
	}
	if err = validateBackupConstraints(ctx, tx); err != nil {
		return err
	}
	var result string
	if err = tx.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil || result != "ok" {
		return ErrInvalidSnapshot
	}
	if _, err = revisionAt(ctx, tx); err != nil {
		return err
	}
	var indexed, revision int64
	if err = tx.QueryRowContext(ctx, "SELECT revision,search_revision FROM memory_meta WHERE id=1").Scan(&revision, &indexed); err != nil || indexed < -1 || indexed > revision {
		return ErrInvalidSnapshot
	}
	if _, err = tx.ExecContext(ctx, "SELECT count(*) FROM memory_search"); err != nil {
		return ErrInvalidSnapshot
	}
	after, err := os.Lstat(file)
	if err != nil || !os.SameFile(before, after) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) || isLinked(after) || !oneLink(file, after) {
		return ErrInvalidSnapshot
	}
	return tx.Commit()
}
