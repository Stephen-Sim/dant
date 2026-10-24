package security

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type revealRepository struct {
	CredentialRepository
	get func(context.Context, string) (Credential, error)
}

func (repository revealRepository) Get(ctx context.Context, id string) (Credential, error) {
	return repository.get(ctx, id)
}

func TestCredentialRevealRequiresExactConversationAndReturnsOnlyExplicitNoStoreDTO(t *testing.T) {
	conversation := "synthetic-conversation"
	reads := 0
	late := false
	repository := revealRepository{get: func(_ context.Context, id string) (Credential, error) {
		reads++
		if late {
			conversation = "replacement-conversation"
		}
		if id != "synthetic-id" {
			return Credential{}, ErrCredentialMissing
		}
		return Credential{CredentialMetadata: CredentialMetadata{ID: id, Name: "not in reveal DTO"}, Secret: "synthetic reveal secret"}, nil
	}}
	requests := NewCredentialRequests(repository, func() { t.Error("reveal emitted a mutation notification") })
	t.Cleanup(requests.Close)
	mux := http.NewServeMux()
	RegisterCredentialRevealRoute(mux, requests, func() string { return conversation })
	request := func(method, body string, status int) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(method, "/api/credentials/reveal/synthetic-id", strings.NewReader(body)))
		if response.Code != status {
			t.Fatalf("reveal status %d, expected %d", response.Code, status)
		}
		if method == http.MethodPost && response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("reveal response allowed caching")
		}
		return response
	}
	for _, body := range []string{`{}`, `{"conversationId":""}`, `{"conversationId":false}`, `{"conversationId":"synthetic-conversation","secret":"unexpected"}`} {
		request(http.MethodPost, body, 400)
	}
	request(http.MethodPost, `{"conversationId":"old-conversation"}`, 409)
	request(http.MethodGet, "", 405)
	if reads != 0 {
		t.Fatal("implicit, invalid or stale request decrypted a credential")
	}
	response := request(http.MethodPost, `{"conversationId":"synthetic-conversation"}`, 200)
	var value map[string]string
	if json.Unmarshal(response.Body.Bytes(), &value) != nil || len(value) != 3 || value["id"] != "synthetic-id" || value["conversationId"] != conversation || value["secret"] != "synthetic reveal secret" {
		t.Fatal("reveal omitted identity or included extra vault metadata")
	}
	late = true
	response = request(http.MethodPost, `{"conversationId":"synthetic-conversation"}`, 409)
	if strings.Contains(response.Body.String(), "synthetic reveal secret") {
		t.Fatal("late reveal leaked into a replacement conversation")
	}
	conversation = "synthetic-conversation"
	missing := httptest.NewRecorder()
	mux.ServeHTTP(missing, httptest.NewRequest(http.MethodPost, "/api/credentials/reveal/missing", strings.NewReader(`{"conversationId":"synthetic-conversation"}`)))
	if missing.Code != 400 || strings.Contains(missing.Body.String(), "synthetic reveal secret") {
		t.Fatal("missing credential did not return a fixed safe failure")
	}
}
