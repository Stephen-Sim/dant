package memory

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"math"
)

type candidate struct {
	rowID        int64
	id, kind     string
	indexedText  string
	updated      sql.NullInt64
	conversation sql.NullString
	work         sql.NullString
	rank         float64
}

type document struct {
	text, normalized string
	textUnits        []uint16
	status           sql.NullString
	source           *Source
	confidence       sql.NullFloat64
}

// FTS columns without affinity may contain integral REAL timestamps. Accept
// only exact timestamp numbers; database/sql's string conversion of a large
// float can use exponent notation, which sql.NullInt64 cannot scan.
type timestampScanner struct{ target *sql.NullInt64 }

func (scanner timestampScanner) Scan(source any) error {
	var timestamp int64
	switch value := source.(type) {
	case nil:
		*scanner.target = sql.NullInt64{}
		return nil
	case int64:
		timestamp = value
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || value <= 0 || value > maxTimestamp {
			return ErrInvalidSnapshot
		}
		timestamp = int64(value)
	default:
		return ErrInvalidSnapshot
	}
	if timestamp <= 0 || timestamp > maxTimestamp {
		return ErrInvalidSnapshot
	}
	*scanner.target = sql.NullInt64{Int64: timestamp, Valid: true}
	return nil
}

func mapCandidates(rows *sql.Rows) ([]candidate, error) {
	defer rows.Close()
	result := make([]candidate, 0)
	for rows.Next() {
		var value candidate
		var idType, kindType, textType string
		if err := rows.Scan(&value.rowID, &value.id, &value.kind, &value.indexedText, timestampScanner{&value.updated}, &value.conversation, &value.work, &value.rank, &idType, &kindType, &textType); err != nil {
			return nil, ErrInvalidSnapshot
		}
		if idType != "text" || kindType != "text" || textType != "text" || value.rowID <= 0 || !validID(value.id) || len(value.indexedText) > maxDocumentBytes || math.IsNaN(value.rank) || math.IsInf(value.rank, 0) {
			return nil, ErrInvalidSnapshot
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func parseSource(value string) (*Source, error) {
	if len(value) > maxSourceBytes {
		return nil, ErrInvalidSnapshot
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(value), &fields); err != nil || fields == nil {
		return nil, ErrInvalidSnapshot
	}
	result := &Source{}
	for key, raw := range fields {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, ErrInvalidSnapshot
		}
		switch key {
		case "kind":
			if json.Unmarshal(raw, &result.Kind) != nil || (result.Kind != "user" && result.Kind != "task" && result.Kind != "inference") {
				return nil, ErrInvalidSnapshot
			}
		case "conversationId", "workId", "messageId":
			var id string
			if json.Unmarshal(raw, &id) != nil || !validID(id) {
				return nil, ErrInvalidSnapshot
			}
			switch key {
			case "conversationId":
				result.ConversationID = &id
			case "workId":
				result.WorkID = &id
			case "messageId":
				result.MessageID = &id
			}
		case "at":
			var at int64
			if json.Unmarshal(raw, &at) != nil || at <= 0 || at > maxTimestamp {
				return nil, ErrInvalidSnapshot
			}
			result.At = &at
		default:
			return nil, ErrInvalidSnapshot
		}
	}
	if result.Kind == "" {
		return nil, ErrInvalidSnapshot
	}
	return result, nil
}

func optional(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func sameID(first, second *string) bool {
	return first == nil && second == nil || first != nil && second != nil && *first == *second
}

func result(row candidate, text Text) SearchResult {
	value := SearchResult{Kind: row.kind, ID: row.id, Text: text, Score: -row.rank, ConversationID: optional(row.conversation), WorkID: optional(row.work)}
	if row.updated.Valid {
		value.UpdatedAt = &row.updated.Int64
	}
	return value
}
