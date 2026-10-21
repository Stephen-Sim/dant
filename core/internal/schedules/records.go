package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
)

// visitRecords keeps persisted row mapping identical for live reads, backup
// validation and staged restore. Callers own the transaction and its mode.
func visitRecords(ctx context.Context, tx *sql.Tx, visit func(Record, json.RawMessage) error) error {
	rows, err := tx.QueryContext(ctx, "SELECT id,client_request_id,record_json FROM schedules ORDER BY rowid")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, raw string
		var request sql.NullString
		if err := rows.Scan(&id, &request, &raw); err != nil {
			return err
		}
		record, err := decodeRecord(json.RawMessage(raw))
		if err != nil || record.ID != id || (record.ClientRequestID != nil) != request.Valid || request.Valid && *record.ClientRequestID != request.String {
			return ErrInvalid
		}
		if err := visit(record, json.RawMessage(raw)); err != nil {
			return err
		}
	}
	return rows.Err()
}
