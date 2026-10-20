package memory

import (
	"context"
	"database/sql"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type queryReader struct{ repository *repository }

func (r *queryReader) Search(ctx context.Context, query PreparedQuery, options SearchOptions) ([]SearchResult, error) {
	query.Terms = slices.Clone(query.Terms)
	if options.ConversationID != nil {
		conversation := *options.ConversationID
		options.ConversationID = &conversation
	}
	if options.Limit < 1 || options.Limit > MaxSearchLimit {
		return nil, ErrInvalidLimit
	}
	if options.ConversationID != nil && !validID(*options.ConversationID) {
		return nil, ErrInvalidScope
	}
	expression, err := prepare(query, " AND ", MaxSearchPreparedUnits)
	if err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0)
	err = r.repository.read(ctx, func(tx *sql.Tx) error {
		if expression == "" {
			return nil
		}
		rows, err := r.repository.search(ctx, tx, expression, options)
		if err != nil {
			return err
		}
		for _, row := range rows {
			document, err := readDocument(ctx, tx, row)
			if err != nil {
				return err
			}
			if document == nil || (document.status.Valid && contracts.MemoryEntryStatus(document.status.String) != contracts.MemoryEntryStatusConfirmed) {
				continue
			}
			text := document.textUnits
			if text == nil {
				text = units(SanitizeText(document.text))
			}
			results = append(results, result(row, Text{units: unitSlice(text, 0, ExcerptUnits)}))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func sourceMatches(kind string, source *Source, scope Scope) bool {
	if source.ConversationID == nil && source.WorkID == nil {
		return kind == "semantic"
	}
	return source.ConversationID != nil && *source.ConversationID == scope.ConversationID && (source.WorkID == nil || sameID(source.WorkID, scope.WorkID))
}

func (r *queryReader) Retrieve(ctx context.Context, query PreparedQuery, scope Scope, options RetrieveOptions) ([]Reference, error) {
	query.Terms = slices.Clone(query.Terms)
	if scope.WorkID != nil {
		work := *scope.WorkID
		scope.WorkID = &work
	}
	if !validID(scope.ConversationID) || (scope.WorkID != nil && !validID(*scope.WorkID)) {
		return nil, ErrInvalidScope
	}
	if options.Limit < 1 || options.Limit > DefaultRetrieveLimit {
		return nil, ErrInvalidLimit
	}
	expression, err := prepare(query, " OR ", MaxQueryUnits)
	if err != nil {
		return nil, err
	}
	results := make([]Reference, 0)
	err = r.repository.read(ctx, func(tx *sql.Tx) error {
		if expression == "" {
			return nil
		}
		rows, err := r.repository.retrieve(ctx, tx, expression, scope, options.Limit)
		if err != nil {
			return err
		}
		remaining := RetrievalBudgetUnits
		for _, row := range rows {
			document, err := readDocument(ctx, tx, row)
			if err != nil {
				return err
			}
			if document == nil {
				continue
			}
			if document.status.Valid && (contracts.MemoryEntryStatus(document.status.String) != contracts.MemoryEntryStatusConfirmed || !sourceMatches(row.kind, document.source, scope)) {
				continue
			}
			text, matched := relevantExcerpt(document.text, document.normalized, query.Terms, min(remaining, ExcerptUnits))
			if document.textUnits != nil {
				text, matched = relevantExcerptUnits(document.textUnits, document.normalized, query.Terms, min(remaining, ExcerptUnits))
			}
			if !matched {
				continue
			}
			reference := Reference{SearchResult: result(row, text)}
			if document.source != nil {
				reference.Source = document.source
				reference.Confidence = &NullableNumber{}
				if document.confidence.Valid {
					reference.Confidence.value = &document.confidence.Float64
				}
			}
			results = append(results, reference)
			remaining -= text.UTF16Length()
			if remaining <= 0 {
				break
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}
