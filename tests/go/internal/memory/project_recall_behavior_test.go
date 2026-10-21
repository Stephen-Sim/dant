package memory

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestManagementAndAgentRecallRetainProjectScopeAndApplyRedaction(t *testing.T) {
	s := openStoreFixture(t)
	project := ProjectContext{Version: 1, UpdatedAt: 1000, OriginalRequest: &ProjectEntry{MessageID: "request", At: 1000, Text: "projectneedle authored request", Attachments: []ProjectAttachment{}}, HumanUpdates: []ProjectEntry{{MessageID: "followup", At: 1100, Text: "projectneedle update", Attachments: []ProjectAttachment{}}}, Results: []ProjectEntry{{MessageID: "delivery", At: 1200, Text: "projectneedle verified result", Attachments: []ProjectAttachment{}}}}
	raw, err := json.Marshal(project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteProject(t.Context(), "current", "work", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteProject(t.Context(), "foreign", "other-work", raw); err != nil {
		t.Fatal(err)
	}
	page, err := s.ManagementPage(t.Context(), "current", "projectneedle", 0, nil)
	if err != nil || len(page.Projects) != 1 || page.Projects[0].ID != "work" || page.Projects[0].WorkID != "work" || !strings.Contains(page.Projects[0].Text, "authored request") {
		t.Fatal("management project search crossed scope or lost work identity", page, err)
	}
	redact := func(text string) string {
		if text == "work" {
			return "[redacted]"
		}
		return text
	}
	page, err = s.ManagementPage(t.Context(), "current", "projectneedle", 0, redact)
	if err != nil || len(page.Projects) != 0 {
		t.Fatal("redacted project identity was exposed", page, err)
	}
	context, err := s.AgentContext(t.Context(), "projectneedle", Scope{ConversationID: "current", WorkID: ptr("work")}, ptr("current-message"), nil)
	if err != nil || !strings.Contains(context, "<dant_recalled_memory>") || !strings.Contains(context, `"messageId":"current-message"`) || !strings.Contains(context, "verified result") || strings.Contains(context, "other-work") {
		t.Fatal("agent recall lost its reference envelope or project boundary", err)
	}
	if text, err := s.AgentContext(t.Context(), " ", Scope{}, nil, nil); err != nil || text != "" {
		t.Fatal("empty query invented context", err)
	}
	if text, err := s.AgentContext(t.Context(), "unmatched term", Scope{ConversationID: "current"}, nil, nil); err != nil || text != "" {
		t.Fatal("missing recall invented context", err)
	}
	if _, err := s.AgentContext(t.Context(), "projectneedle", Scope{}, nil, nil); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("unscoped agent recall was accepted", err)
	}
}

func TestProjectContextValidationBoundsEntriesAndPreservesUnmodifiedUTF16(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"version":2,"updatedAt":1000}`, `{"version":1,"updatedAt":0}`, `{"version":1,"updatedAt":1000,"originalRequest":{}}`} {
		if project, err := SafeProjectContext(json.RawMessage(raw)); err == nil && project.OriginalRequest != nil {
			t.Fatal("invalid project entry was accepted")
		}
	}
	project, err := SafeProjectContext(json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"authored\ud800text","turnId":"turn","attachments":[null,{"id":"invalid"},{"id":"18f6d590-647f-4576-ae90-1e6c432f5370","name":"file","type":"text/plain","size":4}]},"humanUpdates":[null,{"messageId":"update","at":1001,"text":"updated","attachments":[]}],"results":[{"messageId":"result","at":1002,"text":"delivered","attachments":[]}]}`))
	if err != nil || project.OriginalRequest == nil || project.OriginalRequest.TurnID == nil || len(project.OriginalRequest.Attachments) != 1 || project.OriginalRequest.Attachments[0].Size == nil || len(project.HumanUpdates) != 1 || len(project.Results) != 1 {
		t.Fatal("project mapper did not retain validated authored entries", project, err)
	}
	text := projectText(project)
	if !strings.Contains(text, "updated\ndelivered") || len(projectTextUnits(project)) == 0 {
		t.Fatal("project search text lost ordered updates and results")
	}
	raw, err := json.Marshal(project)
	if err != nil || !strings.Contains(string(raw), `\ud800`) {
		t.Fatal("unchanged project text lost its observed UTF-16 units", err)
	}
	project.OriginalRequest.Text = "replacement"
	raw, err = json.Marshal(project)
	if err != nil || strings.Contains(string(raw), `\ud800`) {
		t.Fatal("explicit replacement resurrected old UTF-16 content", err)
	}
}
