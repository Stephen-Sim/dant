package memory

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestProjectSnapshotsBoundAttachmentsRecentEntriesAndEncodedSize(t *testing.T) {
	attachment := map[string]any{"id": "df41f343-a914-44a1-a04c-937937352f3c", "name": strings.Repeat("<", 200), "type": strings.Repeat(">", 100), "size": 1000}
	files := make([]any, 8)
	for index := range files {
		files[index] = attachment
	}
	makeEntry := func(id string, at int) map[string]any {
		return map[string]any{"messageId": id, "at": at, "text": strings.Repeat("<", 2000), "attachments": files}
	}
	updates, results := []any{}, []any{}
	for index := range 12 {
		updates = append(updates, makeEntry("update", index*2+1))
		results = append(results, makeEntry("result", index*2+2))
	}
	raw, err := json.Marshal(map[string]any{"version": 1, "updatedAt": 1000, "originalRequest": makeEntry("request", 1), "humanUpdates": updates, "results": results})
	if err != nil {
		t.Fatal(err)
	}
	project, err := SafeProjectContext(raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(project)
	if err != nil || len(encoded) > MaxNoteBytes || len(project.OriginalRequest.Attachments) != 5 || len(project.HumanUpdates) >= 8 || len(project.Results) >= 8 {
		t.Fatal("project exceeded its attachment, history or encoded snapshot bound", err)
	}
	if len(project.Results) == 0 || project.Results[len(project.Results)-1].At != 24 || project.OriginalRequest.MessageID != "request" {
		t.Fatal("bounded snapshot discarded its original request or newest result")
	}
	// Explicit edits must replace any preserved legacy UTF-16 representation.
	project.OriginalRequest.Text = "Explicitly edited request"
	text := stringFromUnits(projectTextUnits(project))
	if !strings.HasPrefix(text, "Explicitly edited request") {
		t.Fatal("project reference text resurrected the previous source bytes")
	}
	if _, err := marshalJS(make(chan string)); err == nil {
		t.Fatal("unsupported JSON value was reported serialized")
	}
}

func TestMemoryNotesRejectSanitizedExpansionAndCorruptConfidenceWithoutPartialUpdates(t *testing.T) {
	s := openStoreFixture(t)
	before, err := s.ReadNote(t.Context(), "identity.md")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Repeat("password=x ", MaxNoteBytes/len("password=x "))
	if len(text) > MaxNoteBytes || len(SanitizeText(text)) <= MaxNoteBytes {
		t.Fatal("fixture does not exercise sanitization expansion")
	}
	if err := s.WriteNote(t.Context(), "identity.md", text); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("sanitization expansion bypassed the persisted byte bound", err)
	}
	after, err := s.ReadNote(t.Context(), "identity.md")
	if err != nil || after != before {
		t.Fatal("rejected expanded note changed SQL authority", err)
	}
	entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Original fact", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	memoryFixtureSQL(t, s, "PRAGMA ignore_check_constraints=ON;UPDATE memory_entries SET confidence=1.1 WHERE id=?", entry.ID)
	if _, err := s.Entries(t.Context(), ""); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("corrupt persisted confidence entered memory", err)
	}
	if validSource(Source{Kind: "user", MessageID: ptr("password=fixture")}) {
		t.Fatal("secret-shaped source identifier became durable reference metadata")
	}
	if _, err := s.ReadProject(t.Context(), "", "work"); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("invalid project read scope accepted", err)
	}
	if _, err := s.WriteProject(t.Context(), "conversation", "", []byte(`{}`)); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("invalid project write scope accepted", err)
	}
	if _, err := s.WriteProject(t.Context(), "conversation", "work", []byte(`null`)); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid project snapshot accepted", err)
	}
}
