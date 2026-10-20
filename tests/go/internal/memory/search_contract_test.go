package memory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestLiveStoreRetrievalUsesConfirmedAuthorityAndExactProjectScope(t *testing.T) {
	ctx := t.Context()
	store := openStoreFixture(t)
	if err := store.WriteNote(ctx, "identity.md", "Cobalt renderer preference; api_key=fixture-sensitive-value"); err != nil {
		t.Fatal(err)
	}
	global, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Cobalt renderer", Source: Source{Kind: "user"}, Confidence: ptr(0.0)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Confirm(ctx, global.ID, false); err != nil {
		t.Fatal(err)
	}
	candidate, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Cobalt renderer candidate", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	references, err := store.Retrieve(ctx, "cobalt renderer", Scope{ConversationID: "conv-a"}, RetrieveOptions{Limit: 6})
	if err != nil || !slices.Equal(ids(references), []string{global.ID, "identity.md"}) {
		t.Fatal("candidate content entered automatic recall", err)
	}
	for _, reference := range references {
		raw, err := json.Marshal(reference)
		if err != nil || strings.Contains(string(raw), "fixture-sensitive-value") || reference.ID == candidate.ID {
			t.Fatal("recall exposed unconfirmed or sensitive content", err)
		}
		if reference.ID == global.ID && (reference.Confidence == nil || reference.Confidence.value == nil || *reference.Confidence.value != 0) {
			t.Fatal("explicit zero confidence became null or omitted")
		}
	}
	for _, owner := range []struct{ conversation, work string }{
		{"conv-b", "outside-a"}, {"conv-b", "outside-b"}, {"conv-a", "other-work"}, {"conv-a", "wanted-work"},
	} {
		project := json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"Observatory calibration","attachments":[]},"humanUpdates":[],"results":[]}`)
		if _, err := store.WriteProject(ctx, owner.conversation, owner.work, project); err != nil {
			t.Fatal(err)
		}
	}
	references, err = store.Retrieve(ctx, "observatory", Scope{ConversationID: "conv-a", WorkID: ptr("wanted-work")}, RetrieveOptions{Limit: 1})
	if err != nil || len(references) != 1 || references[0].Kind != "project" || references[0].ID != "wanted-work" {
		t.Fatal("foreign project consumed the retrieval limit", err)
	}
	references, err = store.Retrieve(ctx, "observatory", Scope{ConversationID: "conv-a"}, RetrieveOptions{Limit: 6})
	if err != nil || len(references) != 0 {
		t.Fatal("omitted work scope broadened project recall", err)
	}
}

func TestLiveStoreSearchRechecksIndexedTextAndSourceAgainstAuthority(t *testing.T) {
	ctx := t.Context()
	store := openStoreFixture(t)
	entry, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Verified copper renderer", Source: Source{Kind: "user", ConversationID: ptr("conv-a")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Confirm(ctx, entry.ID, false); err != nil {
		t.Fatal(err)
	}
	if results, err := store.Search(ctx, "copper renderer", SearchOptions{Limit: 10}); err != nil || len(results) != 1 {
		t.Fatal("live writer did not build its current index", err)
	}
	if err := store.connection(ctx, func(db *sql.DB) error {
		_, err := db.ExecContext(ctx, "UPDATE memory_search SET text='forgedkeyword api_key=fixture-index-secret' WHERE document_key=?", entry.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	results, err := store.Search(ctx, "forgedkeyword", SearchOptions{Limit: 10})
	if err != nil || len(results) != 1 || stringFromUnits(results[0].Text.units) != entry.Text {
		t.Fatal("search displayed indexed text instead of the authoritative content", err)
	}
	references, err := store.Retrieve(ctx, "forgedkeyword", Scope{ConversationID: "conv-a"}, RetrieveOptions{Limit: 6})
	if err != nil || len(references) != 0 {
		t.Fatal("FTS-only text was accepted as an automatic memory reference", err)
	}
	if err := store.connection(ctx, func(db *sql.DB) error {
		_, err := db.ExecContext(ctx, "UPDATE memory_search SET text='copper renderer',conversation_id='conv-b' WHERE document_key=?", entry.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Search(ctx, "copper", SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("forged source scope was not rejected", err)
	}
}

func TestLiveProjectSearchPreservesAuthoritativeUTF16AtTheExcerptBoundary(t *testing.T) {
	ctx := t.Context()
	store := openStoreFixture(t)
	project := json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"` + strings.Repeat("x", 511) + `\ud83d cobalt","attachments":[]},"humanUpdates":[],"results":[]}`)
	if _, err := store.WriteProject(ctx, "conversation", "project", project); err != nil {
		t.Fatal(err)
	}
	results, err := store.Search(ctx, "cobalt", SearchOptions{Limit: 10, ConversationID: ptr("conversation")})
	if err != nil || len(results) != 1 || results[0].ID != "project" || results[0].Text.UTF16Length() != ExcerptUnits {
		t.Fatal("project search lost its exact scope or excerpt bound", err)
	}
	raw, err := json.Marshal(results[0].Text)
	if err != nil || !strings.HasSuffix(string(raw), `\ud83d"`) || strings.Contains(string(raw), "�") {
		t.Fatal("project search replaced an authored UTF-16 boundary unit", err)
	}
}
