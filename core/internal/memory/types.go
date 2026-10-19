// Package memory queries an owner-prepared, redacted SQLite shadow snapshot.
// It never opens a path, refreshes FTS, writes memory, or authorizes execution.
package memory

import (
	"encoding/json"
	"errors"
)

const (
	DefaultSearchLimit     = 10
	DefaultRetrieveLimit   = 6
	MaxSearchLimit         = 50
	MaxTerms               = 16
	MaxQueryUnits          = 256
	MaxSearchPreparedUnits = 8192
	MaxIDUnits             = 256
	ExcerptUnits           = 512
	RetrievalBudgetUnits   = 2048
	excerptLeadUnits       = 96
	maxDocumentBytes       = 4 * 1024 * 1024
	maxSourceBytes         = 4096
	maxSafeInteger         = 9007199254740991
	maxTimestamp           = 8640000000000000
)

var (
	ErrInvalidQuery    = errors.New("memory_invalid_query")
	ErrInvalidScope    = errors.New("memory_invalid_scope")
	ErrInvalidLimit    = errors.New("memory_invalid_limit")
	ErrStaleSnapshot   = errors.New("memory_stale_snapshot")
	ErrInvalidSnapshot = errors.New("memory_invalid_snapshot")
	ErrUnavailable     = errors.New("memory_unavailable")
)

// Terms are prepared by the existing TypeScript sanitizer, NFKC normalization,
// tokenizer, CJK expansion and (for retrieval) stop-word filter.
type PreparedQuery struct {
	Terms []string `json:"terms"`
}

// Limit is required. The transport supplies defaults only for omitted values.
type SearchOptions struct {
	Limit          int     `json:"limit"`
	ConversationID *string `json:"conversationId,omitempty"`
}

type RetrieveOptions struct {
	Limit int `json:"limit"`
}

// A nil WorkID means omitted. Explicit JSON null must be rejected by transport.
type Scope struct {
	ConversationID string  `json:"conversationId"`
	WorkID         *string `json:"workId,omitempty"`
}

type Source struct {
	Kind           string  `json:"kind"`
	ConversationID *string `json:"conversationId,omitempty"`
	WorkID         *string `json:"workId,omitempty"`
	MessageID      *string `json:"messageId,omitempty"`
	At             *int64  `json:"at,omitempty"`
}

type SearchResult struct {
	Kind           string  `json:"kind"`
	ID             string  `json:"id"`
	Text           Text    `json:"text"`
	Score          float64 `json:"score"`
	UpdatedAt      *int64  `json:"updatedAt,omitempty"`
	ConversationID *string `json:"conversationId,omitempty"`
	WorkID         *string `json:"workId,omitempty"`
}

// A present NullableNumber preserves a confirmed entry's explicit null
// confidence; a nil outer pointer omits the field for notes and projects.
type NullableNumber struct{ value *float64 }

func (n NullableNumber) MarshalJSON() ([]byte, error) { return json.Marshal(n.value) }

type Reference struct {
	SearchResult
	Source     *Source         `json:"source,omitempty"`
	Confidence *NullableNumber `json:"confidence,omitempty"`
}
