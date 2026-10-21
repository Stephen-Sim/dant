package memory

import (
	"context"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type ManagementRecord struct {
	ID       string                       `json:"id"`
	Kind     string                       `json:"kind"`
	Text     string                       `json:"text"`
	Status   *contracts.MemoryEntryStatus `json:"status"`
	Source   *Source                      `json:"source"`
	Redacted bool                         `json:"redacted"`
}

type ManagementProject struct {
	ID     string `json:"id"`
	WorkID string `json:"workId"`
	Text   string `json:"text"`
}

type IdentityView struct {
	Text string `json:"text"`
}

type ManagementPage struct {
	Storage        string              `json:"storage"`
	ConversationID string              `json:"conversationId"`
	Revision       string              `json:"revision"`
	Query          string              `json:"query"`
	Offset         int                 `json:"offset"`
	Identity       IdentityView        `json:"identity"`
	Records        []ManagementRecord  `json:"records"`
	Total          int                 `json:"total"`
	HasMore        bool                `json:"hasMore"`
	Projects       []ManagementProject `json:"projects"`
}

func (s *Store) ManagementPage(ctx context.Context, conversation, query string, offset int, redact func(string) string) (ManagementPage, error) {
	if !validID(conversation) || offset < 0 || offset > 9999 || unitLength(query) > MaxQueryUnits || strings.ContainsRune(query, 0) {
		return ManagementPage{}, ErrInvalidMemory
	}
	if redact == nil {
		redact = func(text string) string { return text }
	}
	safe := func(text string) string { return redact(SanitizeText(text)) }
	snapshot, err := s.ManagementSnapshot(ctx)
	if err != nil {
		return ManagementPage{}, err
	}
	matches := []SearchResult{}
	if trimText(query) != "" {
		matches, err = s.Search(ctx, query, SearchOptions{Limit: MaxSearchLimit, ConversationID: &conversation})
		if err != nil {
			return ManagementPage{}, err
		}
	}
	matched := map[string]bool{}
	for _, match := range matches {
		if match.Kind != "project" {
			matched[match.ID] = true
		}
	}
	search := cases.Lower(language.Und).String(trimText(query))
	visible := func(id, text string) bool {
		return search == "" || matched[id] || strings.Contains(cases.Lower(language.Und).String(text), search)
	}
	records := []ManagementRecord{}
	for _, note := range snapshot.Notes {
		if note.Name != "identity.md" && note.Name != "working-memory.md" {
			continue
		}
		text := safe(note.Text)
		if visible(note.Name, text) {
			records = append(records, ManagementRecord{ID: note.Name, Kind: "note", Text: text, Redacted: text != note.Text})
		}
	}
	for _, entry := range snapshot.Entries {
		if entry.Source.ConversationID != nil && *entry.Source.ConversationID != conversation {
			continue
		}
		text := safe(entry.Text)
		if !visible(entry.ID, text) {
			continue
		}
		source := entry.Source
		for _, value := range []*string{source.ConversationID, source.WorkID, source.MessageID} {
			if value != nil && redact(*value) != *value {
				source = Source{Kind: source.Kind}
				break
			}
		}
		status := entry.Status
		records = append(records, ManagementRecord{entry.ID, entry.Kind, text, &status, &source, text != entry.Text})
	}
	page := ManagementPage{
		Storage:        "sqlite",
		ConversationID: conversation,
		Revision:       snapshot.Revision,
		Query:          query,
		Offset:         offset,
		Identity:       IdentityView{IdentityInstructions},
		Records:        []ManagementRecord{},
		Total:          len(records),
		HasMore:        offset+ManagementPageSize < len(records),
		Projects:       []ManagementProject{},
	}
	if offset < len(records) {
		page.Records = records[offset:min(len(records), offset+ManagementPageSize)]
	}
	for _, match := range matches {
		if match.Kind == "project" && match.ConversationID != nil && *match.ConversationID == conversation && redact(match.ID) == match.ID && (match.WorkID == nil || redact(*match.WorkID) == *match.WorkID) {
			work := match.ID
			if match.WorkID != nil {
				work = *match.WorkID
			}
			page.Projects = append(page.Projects, ManagementProject{match.ID, work, safe(stringFromUnits(match.Text.units))})
		}
	}
	return page, nil
}

func (s *Store) ManageForConversation(ctx context.Context, conversation string, mutation Mutation, redact func(string) string) (ManagementResult, error) {
	if !validID(conversation) {
		return ManagementResult{}, ErrInvalidMemory
	}
	if redact == nil {
		redact = func(text string) string { return text }
	}
	snapshot, err := s.ManagementSnapshot(ctx)
	if err != nil {
		return ManagementResult{}, err
	}
	if snapshot.Revision != mutation.Revision {
		return ManagementResult{}, ErrConflict
	}
	original := ""
	found := false
	if mutation.Kind == "note" {
		for _, note := range snapshot.Notes {
			if note.Name == mutation.ID {
				original = note.Text
				found = true
			}
		}
	} else {
		for _, entry := range snapshot.Entries {
			if entry.ID == mutation.ID && entry.Kind == mutation.Kind {
				if entry.Source.ConversationID != nil && *entry.Source.ConversationID != conversation {
					return ManagementResult{}, ErrInvalidMemory
				}
				original = entry.Text
				found = true
			}
		}
	}
	if !found {
		return ManagementResult{}, ErrNotFound
	}
	if mutation.Action == "update" && (mutation.Text == nil || ContainsSecret(*mutation.Text) || redact(*mutation.Text) != *mutation.Text || redact(SanitizeText(original)) != original) {
		return ManagementResult{}, ErrInvalidMemory
	}
	return s.Manage(ctx, mutation)
}

type MemoryView struct {
	ConversationID string       `json:"conversationId"`
	ReadOnly       bool         `json:"readOnly"`
	Identity       IdentityView `json:"identity"`
	Memory         IdentityView `json:"memory"`
}

func (s *Store) View(ctx context.Context, conversation string, redact func(string) string) (MemoryView, error) {
	if !validID(conversation) {
		return MemoryView{}, ErrInvalidMemory
	}
	text, err := s.Context(ctx, true)
	if err != nil {
		return MemoryView{}, err
	}
	if redact != nil {
		text = redact(text)
	}
	return MemoryView{conversation, true, IdentityView{IdentityInstructions}, IdentityView{text}}, nil
}
