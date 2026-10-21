package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// PauseRestoredDatabase operates only on the restore owner's private staged
// database. It cannot create/migrate a missing database and never admits work.
func PauseRestoredDatabase(ctx context.Context, file string) error {
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
	uri := url.URL{Scheme: "file", Path: uriPath, RawQuery: url.Values{"mode": {"rw"}}.Encode()}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return ErrInvalid
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=5000;PRAGMA trusted_schema=OFF;PRAGMA synchronous=FULL;"); err != nil {
		return ErrInvalid
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return ErrInvalid
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "UPDATE schedule_meta SET revision=revision WHERE id=1"); err != nil {
		return ErrInvalid
	}
	if err = validateSchema(ctx, tx); err != nil {
		return err
	}
	var result string
	if err = tx.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil || result != "ok" {
		return ErrInvalid
	}
	type staged struct {
		id  string
		raw []byte
	}
	updates := []staged{}
	err = visitRecords(ctx, tx, func(record Record, raw json.RawMessage) error {
		fields, err := contracts.DecodeObject(raw, MaxRecordBytes)
		if err != nil {
			return ErrInvalid
		}
		fields["enabled"] = json.RawMessage("false")
		if record.Status != contracts.ScheduleStatusDispatched {
			fields["status"], _ = json.Marshal(contracts.ScheduleStatusPaused)
		}
		data, err := json.Marshal(fields)
		if err != nil {
			return ErrInvalid
		}
		updates = append(updates, staged{record.ID, data})
		return nil
	})
	if err != nil {
		return ErrInvalid
	}
	for _, update := range updates {
		if _, err = tx.ExecContext(ctx, "UPDATE schedules SET record_json=? WHERE id=?", string(update.raw), update.id); err != nil {
			return ErrInvalid
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE schedule_dispatches SET phase=? WHERE phase IN (?,?)", contracts.ScheduleDispatchPhaseHeld, contracts.ScheduleDispatchPhasePrepared, contracts.ScheduleDispatchPhaseMaterialized); err != nil {
		return ErrInvalid
	}
	after, err := os.Lstat(file)
	if err != nil || !os.SameFile(before, after) || linked(after) || !singleLink(file, after) {
		return ErrInvalid
	}
	return tx.Commit()
}
