package memory

import (
	"encoding/json"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	MaxNoteBytes       = 64 * 1024
	MaxEntryBytes      = 4096
	MaxEntries         = 1000
	ContextEntryLimit  = 32
	ManagementPageSize = 40
)

var noteNames = []string{"README.md", "identity.md", "working-memory.md"}

type StoreOptions struct {
	Now   func() time.Time
	NewID func() string
}

type Note struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type Entry struct {
	ID            string                      `json:"id"`
	Kind          string                      `json:"kind"`
	Text          string                      `json:"text"`
	Key           string                      `json:"key"`
	Status        contracts.MemoryEntryStatus `json:"status"`
	Source        Source                      `json:"source"`
	Confidence    *float64                    `json:"confidence"`
	ConflictsWith []string                    `json:"conflictsWith"`
	CreatedAt     int64                       `json:"createdAt"`
	UpdatedAt     int64                       `json:"updatedAt"`
}

type Proposal struct {
	Kind       string   `json:"kind"`
	Text       string   `json:"text"`
	Source     Source   `json:"source"`
	Key        *string  `json:"key,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type ManagementSnapshot struct {
	Revision string  `json:"revision"`
	Notes    []Note  `json:"notes"`
	Entries  []Entry `json:"entries"`
}

type Mutation struct {
	Revision string  `json:"revision"`
	Kind     string  `json:"kind"`
	ID       string  `json:"id"`
	Action   string  `json:"action"`
	Text     *string `json:"text,omitempty"`
}

type ManagementResult struct {
	Revision string `json:"revision"`
}

type ProjectAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Size *int64 `json:"size,omitempty"`
}

type ProjectEntry struct {
	MessageID    string              `json:"messageId"`
	TurnID       *string             `json:"turnId,omitempty"`
	At           int64               `json:"at"`
	Text         string              `json:"text"`
	Attachments  []ProjectAttachment `json:"attachments"`
	originalText *Text
	decodedText  string
}

type ProjectContext struct {
	Version           int            `json:"version"`
	ReferenceDataOnly bool           `json:"referenceDataOnly"`
	UpdatedAt         int64          `json:"updatedAt"`
	OriginalRequest   *ProjectEntry  `json:"originalRequest"`
	HumanUpdates      []ProjectEntry `json:"humanUpdates"`
	Results           []ProjectEntry `json:"results"`
}

type EntryPatch map[string]json.RawMessage

func validNote(name string) bool {
	for _, candidate := range noteNames {
		if candidate == name {
			return true
		}
	}
	return false
}

func validTime(value int64) bool { return value > 0 && value <= maxTimestamp }
