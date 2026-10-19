package memory

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

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
