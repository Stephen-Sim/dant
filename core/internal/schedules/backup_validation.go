package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func ValidateBackupRecords(records []json.RawMessage) error {
	seen, requests := map[string]bool{}, map[string]bool{}
	for _, raw := range records {
		record, err := decodeRecord(raw)
		if err != nil || seen[record.ID] {
			return ErrInvalid
		}
		seen[record.ID] = true
		if record.ClientRequestID != nil {
			if requests[*record.ClientRequestID] {
				return ErrInvalid
			}
			requests[*record.ClientRequestID] = true
		}
	}
	return nil
}

// ValidateBackupDatabase reads only the restore owner's private staged file.
// It does not create schema, take a writer lock, pause work or repair metadata.
func ValidateBackupDatabase(ctx context.Context, file string) error {
	before, err := os.Lstat(file)
	if err != nil || !before.Mode().IsRegular() || linked(before) || !singleLink(file, before) {
		return ErrInvalid
	}
	absolute, err := filepath.Abs(file)
	if err != nil {
		return ErrInvalid
	}
	uriPath := filepath.ToSlash(absolute)
	if filepath.VolumeName(absolute) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath, RawQuery: url.Values{"mode": {"ro"}}.Encode()}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return ErrInvalid
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;"); err != nil {
		return ErrInvalid
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ErrInvalid
	}
	defer tx.Rollback()
	if err = validateSchema(ctx, tx); err != nil {
		return ErrInvalid
	}
	var check string
	if err = tx.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return ErrInvalid
	}
	if _, err = revision(ctx, tx); err != nil {
		return ErrInvalid
	}
	if err = visitRecords(ctx, tx, func(Record, json.RawMessage) error { return nil }); err != nil {
		return ErrInvalid
	}
	rows, err := tx.QueryContext(ctx, "SELECT request_id FROM schedule_tombstones")
	if err != nil {
		return ErrInvalid
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil || !validID(id) {
			rows.Close()
			return ErrInvalid
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return ErrInvalid
	}
	rows, err = tx.QueryContext(ctx, "SELECT message_id,schedule_id,scheduled_at,owner,phase,message_json FROM schedule_dispatches")
	if err != nil {
		return ErrInvalid
	}
	for rows.Next() {
		if _, err := readDispatch(rows); err != nil {
			rows.Close()
			return ErrInvalid
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return ErrInvalid
	}
	after, err := os.Lstat(file)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || linked(after) || !singleLink(file, after) {
		return ErrInvalid
	}
	if err = tx.Commit(); err != nil {
		return ErrInvalid
	}
	return nil
}
