package schedules

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type scanner interface{ Scan(...any) error }

func readDispatch(row scanner) (Dispatch, error) {
	var id, schedule, owner, phase, raw string
	var at int64
	if err := row.Scan(&id, &schedule, &at, &owner, &phase, &raw); err != nil {
		return Dispatch{}, err
	}
	var message ScheduledMessage
	if len(raw) > MaxRecordBytes || json.Unmarshal([]byte(raw), &message) != nil || !message.valid() || message.ID != id || message.ScheduleID != schedule || message.ScheduledAt != at || !validID(owner) || !contracts.ScheduleDispatchPhase(phase).Valid() {
		return Dispatch{}, ErrInvalid
	}
	return Dispatch{message, owner, contracts.ScheduleDispatchPhase(phase)}, nil
}

func (db *Database) materialize(ctx context.Context, id, owner string, held bool, operation func(Dispatch) error) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	applied := false
	err := db.transaction(ctx, func(tx *sql.Tx) error {
		dispatch, err := readDispatch(tx.QueryRowContext(ctx, "SELECT message_id,schedule_id,scheduled_at,owner,phase,message_json FROM schedule_dispatches WHERE message_id=?", id))
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		if held {
			if dispatch.Phase != contracts.ScheduleDispatchPhaseHeld {
				return nil
			}
		} else if dispatch.Owner != owner || dispatch.Phase != contracts.ScheduleDispatchPhasePrepared {
			return nil
		}
		if err = operation(dispatch); err != nil {
			return err
		}
		if !held {
			if _, err = tx.ExecContext(ctx, "UPDATE schedule_dispatches SET phase=? WHERE message_id=?", string(contracts.ScheduleDispatchPhaseMaterialized), id); err != nil {
				return err
			}
		}
		applied = true
		return nil
	})
	return applied, err
}

func (db *Database) Materialize(ctx context.Context, id, owner string, operation func(Dispatch) error) (bool, error) {
	return db.materialize(ctx, id, owner, false, operation)
}

func (db *Database) MaterializeHeld(ctx context.Context, id string, operation func(Dispatch) error) (bool, error) {
	return db.materialize(ctx, id, "", true, operation)
}

func (db *Database) FenceHandoff(ctx context.Context, id, owner string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	changed := false
	err := db.transaction(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "UPDATE schedule_dispatches SET phase=? WHERE message_id=? AND owner=? AND phase=?", string(contracts.ScheduleDispatchPhaseHandedOff), id, owner, string(contracts.ScheduleDispatchPhaseMaterialized))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		changed = count == 1
		return nil
	})
	return changed, err
}

func (db *Database) RecoverPrepared(ctx context.Context, owner string, includeOwned bool) ([]Dispatch, error) {
	if !validID(owner) {
		return nil, ErrInvalid
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	result := []Dispatch{}
	err := db.transaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE schedule_dispatches SET phase=? WHERE (owner<>? OR ?=1) AND phase IN (?,?)", string(contracts.ScheduleDispatchPhaseHeld), owner, includeOwned, string(contracts.ScheduleDispatchPhasePrepared), string(contracts.ScheduleDispatchPhaseMaterialized))
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT message_id,schedule_id,scheduled_at,owner,phase,message_json FROM schedule_dispatches WHERE phase=? ORDER BY rowid", string(contracts.ScheduleDispatchPhaseHeld))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			dispatch, err := readDispatch(rows)
			if err != nil {
				return err
			}
			result = append(result, dispatch)
		}
		return rows.Err()
	})
	return result, err
}
