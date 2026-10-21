package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestManagementPageScopesRedactsAndPaginatesStoredMemory(t *testing.T) {
	s := openStoreFixture(t)
	ctx := t.Context()
	for name, text := range map[string]string{"identity.md": "A multilingual identity 世界", "working-memory.md": "Local working notes"} {
		if err := s.WriteNote(ctx, name, text); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 43 {
		conversation := "current"
		if i == 42 {
			conversation = "other"
		}
		_, err := s.Propose(ctx, Proposal{Kind: "semantic", Text: fmt.Sprintf("Memory record %02d", i), Source: Source{Kind: "user", ConversationID: &conversation}})
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ManagementPage(ctx, "current", "", 0, nil)
	if err != nil || page.Storage != "sqlite" || page.Total != 44 || len(page.Records) != ManagementPageSize || !page.HasMore || !strings.Contains(page.Identity.Text, "dant") {
		t.Fatal("management page lost its SQL scope, identity or pagination", page, err)
	}
	last, err := s.ManagementPage(ctx, "current", "", ManagementPageSize, nil)
	if err != nil || len(last.Records) != 4 || last.HasMore || last.Revision != page.Revision {
		t.Fatal("remaining records did not retain the snapshot revision", last, err)
	}
	empty, err := s.ManagementPage(ctx, "current", "", 9999, nil)
	if err != nil || len(empty.Records) != 0 || empty.Total != 44 {
		t.Fatal("out-of-range page changed the total", empty, err)
	}
	redact := func(text string) string {
		return strings.ReplaceAll(strings.ReplaceAll(text, "current", "[hidden]"), "record 01", "[hidden]")
	}
	filtered, err := s.ManagementPage(ctx, "current", "Memory", 0, redact)
	if err != nil || filtered.Total != 42 || len(filtered.Projects) != 0 {
		t.Fatal("query included unscoped records", filtered, err)
	}
	redacted := false
	for _, record := range filtered.Records {
		if record.Kind != "semantic" || record.Source == nil || record.Source.ConversationID != nil || record.Status == nil || *record.Status != contracts.MemoryEntryStatusCandidate {
			t.Fatal("management source exposed redacted identity", record)
		}
		redacted = redacted || record.Redacted
	}
	if !redacted {
		t.Fatal("changed record text was not marked redacted")
	}
	view, err := s.View(ctx, "current", func(text string) string { return "redacted context" })
	if err != nil || !view.ReadOnly || view.Memory.Text != "redacted context" || view.ConversationID != "current" {
		t.Fatal("read-only context did not use its redactor", view, err)
	}
	for _, input := range []struct {
		conversation, query string
		offset              int
	}{{"", "", 0}, {"current", "", -1}, {"current", "", 10000}, {"current", "a\x00b", 0}, {"current", strings.Repeat("x", MaxQueryUnits+1), 0}} {
		if _, err := s.ManagementPage(ctx, input.conversation, input.query, input.offset, nil); !errors.Is(err, ErrInvalidMemory) {
			t.Fatal("invalid management scope or pagination accepted", err)
		}
	}
}

func TestConversationManagementMutationRetainsRevisionAndOwnership(t *testing.T) {
	s := openStoreFixture(t)
	ctx := t.Context()
	entry, err := s.Propose(ctx, Proposal{Kind: "semantic", Text: "A remembered preference", Source: Source{Kind: "user", ConversationID: ptr("current")}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ManagementSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	mutation := Mutation{Revision: snapshot.Revision, Kind: entry.Kind, ID: entry.ID, Action: "update", Text: ptr("An updated preference")}
	if _, err := s.ManageForConversation(ctx, "", mutation, nil); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("empty conversation accepted", err)
	}
	if _, err := s.ManageForConversation(ctx, "other", mutation, nil); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("another conversation changed an owned entry", err)
	}
	missing := mutation
	missing.ID = "missing"
	if _, err := s.ManageForConversation(ctx, "current", missing, nil); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing entry was invented", err)
	}
	blocked := mutation
	blocked.Text = nil
	if _, err := s.ManageForConversation(ctx, "current", blocked, nil); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("missing replacement was accepted", err)
	}
	if _, err := s.ManageForConversation(ctx, "current", mutation, func(string) string { return "[hidden]" }); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("redacted entry was silently overwritten", err)
	}
	result, err := s.ManageForConversation(ctx, "current", mutation, nil)
	if err != nil || result.Revision == snapshot.Revision {
		t.Fatal("valid edit did not advance the committed revision", result, err)
	}
	if _, err := s.ManageForConversation(ctx, "current", mutation, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("stale edit was replayed", err)
	}
	confirmed, err := s.ManageForConversation(ctx, "current", Mutation{Revision: result.Revision, Kind: entry.Kind, ID: entry.ID, Action: "confirm"}, nil)
	if err != nil || confirmed.Revision == result.Revision {
		t.Fatal("confirmation did not create a receipt", confirmed, err)
	}
	if _, err := s.ManageForConversation(ctx, "current", Mutation{Revision: confirmed.Revision, Kind: entry.Kind, ID: entry.ID, Action: "delete"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestMemoryRoutesValidateRequestsAndConversationSnapshots(t *testing.T) {
	s := openStoreFixture(t)
	conversation := "current"
	changed := 0
	options := RouteOptions{Store: s, ConversationID: func() string { return conversation }, SaveNote: func(_ context.Context, name, text string) (json.RawMessage, error) {
		if name != "identity.md" || text != "new identity" {
			return nil, ErrConflict
		}
		return json.RawMessage(`{"saved":true}`), nil
	}, ConversationTransaction: func(ctx context.Context, _ string, operation func(context.Context) error) error {
		return operation(ctx)
	}, Changed: func(context.Context) error { changed++; return nil }}
	mux := http.NewServeMux()
	RegisterRoutes(mux, options)
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))
		if response.Code != status {
			t.Fatalf("%s %s: got %d, want %d: %s", method, path, response.Code, status, response.Body.String())
		}
		return response
	}
	request("GET", "/api/memory", "", 200)
	request("GET", "/api/memory/view", "", 200)
	request("GET", "/api/memory/manage", "", 200)
	request("GET", "/api/memory/manage?q=absent&offset=0", "", 200)
	for _, query := range []string{"unknown=1", "q=a&q=b", "offset=-1", "offset=01", "offset=10000", "q=%00"} {
		request("GET", "/api/memory/manage?"+query, "", 400)
	}
	for _, method := range []string{"HEAD", "POST", "PATCH", "DELETE", "PUT", "OPTIONS", "TRACE", "CONNECT"} {
		request(method, "/api/memory/view", "", 405)
	}
	request("PATCH", "/api/memory/identity.md", `{"text":"new identity"}`, 200)
	request("PATCH", "/api/memory/identity.md", `{"text":"wrong"}`, 409)
	request("PATCH", "/api/memory/identity.md", `{`, 400)
	request("PATCH", "/api/memory/identity.md", `{"text":false}`, 400)
	for _, body := range []string{`{`, `{}`, `{"conversationId":"other","revision":"1:1"}`, `{"conversationId":"current","revision":"bad"}`, `{"conversationId":"current","revision":"1:1","unknown":true}`, `{"conversationId":"current","revision":"1:1","text":false}`} {
		request("PATCH", "/api/memory/manage/note/identity.md", body, 400)
	}
	snapshot, err := s.ManagementSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"conversationId": "current", "revision": snapshot.Revision, "text": "A changed identity"})
	request("PATCH", "/api/memory/manage/note/identity.md", string(body), 200)
	request("PATCH", "/api/memory/manage/note/identity.md", string(body), 409)
	if changed != 1 {
		t.Fatal("rejected mutation notified a change", changed)
	}
	conversation = ""
	request("GET", "/api/memory/view", "", 400)
	request("GET", "/api/memory/manage", "", 400)
	conversation = "current"
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	request("GET", "/api/memory", "", 503)
	request("GET", "/api/memory/view", "", 503)
	request("GET", "/api/memory/manage", "", 503)
}
