package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagementCommitReturnsNewRevisionWhenLiveNotificationFails(t *testing.T) {
	store := openStoreFixture(t)
	const conversation = "fixture-conversation"
	before, err := store.ManagementSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	notified := 0
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{
		Store:          store,
		ConversationID: func() string { return conversation },
		ConversationTransaction: func(ctx context.Context, id string, operation func(context.Context) error) error {
			if id != conversation {
				t.Fatal("notification crossed conversation identity")
			}
			return operation(ctx)
		},
		Changed: func(context.Context) error {
			notified++
			return errors.New("isolated_live_context_unconfirmed")
		},
	})
	body, err := json.Marshal(map[string]string{
		"conversationId": conversation,
		"revision":       before.Revision,
		"text":           "A confirmed fixture preference.",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPatch, "/api/memory/manage/note/working-memory.md", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	var receipt struct {
		Saved    bool   `json:"saved"`
		Revision string `json:"revision"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &receipt) != nil || !receipt.Saved {
		t.Fatalf("committed SQL change reported unsaved: %d %s", response.Code, response.Body)
	}
	if notified != 1 || receipt.Revision == before.Revision || receipt.Revision == "" {
		t.Fatal("commit receipt lost its new revision")
	}
	note, err := store.ReadNote(t.Context(), "working-memory.md")
	if err != nil || note != "A confirmed fixture preference." {
		t.Fatal("committed note was lost", err)
	}
}
