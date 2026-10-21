package memory

import (
	"context"
	"database/sql"
	"errors"
)

type repository struct {
	db       *sql.DB
	revision int64
}

func safeError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	for _, known := range []error{ErrInvalidQuery, ErrInvalidScope, ErrInvalidLimit, ErrStaleSnapshot, ErrInvalidSnapshot} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrUnavailable
}

func (r *repository) checkRevision(ctx context.Context, tx *sql.Tx) error {
	var revision, indexed int64
	if err := tx.QueryRowContext(ctx, "SELECT revision, search_revision FROM memory_meta WHERE id = 1").Scan(&revision, &indexed); err != nil {
		return ErrInvalidSnapshot
	}
	if revision < 0 || revision > maxSafeInteger || indexed < 0 {
		return ErrInvalidSnapshot
	}
	if revision != indexed || revision != r.revision {
		return ErrStaleSnapshot
	}
	return nil
}

func (r *repository) read(ctx context.Context, operation func(*sql.Tx) error) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return safeError(ctx, err)
	}
	defer tx.Rollback()
	if err = r.checkRevision(ctx, tx); err == nil {
		err = operation(tx)
	}
	if err == nil {
		err = r.checkRevision(ctx, tx)
	}
	if err == nil {
		err = tx.Commit()
	}
	return safeError(ctx, err)
}

func (r *repository) search(ctx context.Context, tx *sql.Tx, expression string, options SearchOptions) ([]candidate, error) {
	rows, err := tx.QueryContext(ctx, searchQuery, sql.Named("expression", expression), sql.Named("conversation", options.ConversationID), sql.Named("limit", options.Limit))
	if err != nil {
		return nil, err
	}
	return mapCandidates(rows)
}

func (r *repository) retrieve(ctx context.Context, tx *sql.Tx, expression string, scope Scope, limit int) ([]candidate, error) {
	rows, err := tx.QueryContext(ctx, retrievalQuery, sql.Named("expression", expression), sql.Named("conversation", scope.ConversationID), sql.Named("work", scope.WorkID), sql.Named("limit", limit))
	if err != nil {
		return nil, err
	}
	return mapCandidates(rows)
}
