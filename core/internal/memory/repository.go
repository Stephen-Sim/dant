package memory

import (
	"context"
	"database/sql"
	"errors"
)

type repository struct {
	db       *sql.DB
	revision int64
	live     bool
}

func newRepository(ctx context.Context, db *sql.DB, expectedRevision int64) (*repository, error) {
	if db == nil || expectedRevision < 0 || expectedRevision > maxSafeInteger {
		return nil, ErrInvalidSnapshot
	}
	reader := &repository{db: db, revision: expectedRevision}
	err := reader.read(ctx, func(tx *sql.Tx) error {
		var version int
		if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 1 {
			return ErrInvalidSnapshot
		}
		for table, columns := range map[string][]string{
			"memory_meta":           {"id", "revision", "search_revision"},
			"memory_search":         {"document_key", "kind", "text", "updated_at", "conversation_id", "work_id"},
			"memory_read_documents": {"search_rowid", "document_key", "kind", "text", "normalized_text", "updated_at", "conversation_id", "work_id", "status", "source_json", "confidence"},
		} {
			rows, err := tx.QueryContext(ctx, "SELECT name FROM pragma_table_info(?) ORDER BY cid", table)
			if err != nil {
				return ErrInvalidSnapshot
			}
			index := 0
			for rows.Next() {
				var name string
				if err := rows.Scan(&name); err != nil || index >= len(columns) || name != columns[index] {
					rows.Close()
					return ErrInvalidSnapshot
				}
				index++
			}
			err = rows.Err()
			rows.Close()
			if err != nil || index != len(columns) {
				return ErrInvalidSnapshot
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return reader, nil
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

func (r *repository) document(ctx context.Context, tx *sql.Tx, row candidate) (*document, error) {
	if r.live {
		return liveDocument(ctx, tx, row)
	}
	return mapDocument(tx.QueryRowContext(ctx, documentQuery, sql.Named("rowid", row.rowID)), row)
}
