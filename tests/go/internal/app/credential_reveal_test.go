package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/security"
)

func TestWorkerCredentialRevealIsAuthenticatedScopedAndNeverPublished(t *testing.T) {
	app := fixtureWorker(t)
	name, service, secret := "Synthetic reveal", "fixture.invalid", "synthetic-app-reveal-secret"
	metadata, err := app.credentials.Upsert(t.Context(), security.CredentialInput{Name: &name, Service: &service, Secret: &secret})
	if err != nil {
		t.Fatal(err)
	}
	route := "/api/credentials/reveal/" + metadata.ID
	body, _ := json.Marshal(map[string]string{"conversationId": app.store.ConversationID()})
	for _, origin := range []string{"", "https://untrusted.invalid"} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317"+route, bytes.NewReader(body))
		if origin != "" {
			request.Header.Set("X-Dant-Token", app.auth.Info().Token)
			request.Header.Set("Origin", origin)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code < 400 || strings.Contains(response.Body.String(), secret) {
			t.Fatal("unauthenticated or cross-origin reveal returned a secret")
		}
	}
	before, _ := json.Marshal(app.store.Snapshot())
	response := callWorker(app, http.MethodPost, route, string(body))
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("explicit reveal did not return a private response")
	}
	var revealed security.CredentialReveal
	if json.Unmarshal(response.Body.Bytes(), &revealed) != nil || revealed.ID != metadata.ID || revealed.Secret != secret {
		t.Fatal("explicit reveal changed the credential identity or value")
	}
	after, _ := json.Marshal(app.store.Snapshot())
	if !bytes.Equal(before, after) {
		t.Fatal("reveal changed authoritative conversation state")
	}
	for _, path := range []string{"/api/credentials", "/api/state", "/api/diagnostics"} {
		result := callWorker(app, http.MethodGet, path, "")
		if result.Code != 200 || strings.Contains(result.Body.String(), secret) {
			t.Fatal("metadata/state/diagnostics included a revealed secret")
		}
	}
	response = callWorker(app, http.MethodPost, route, `{"conversationId":"stale"}`)
	if response.Code != 409 || strings.Contains(response.Body.String(), secret) {
		t.Fatal("stale conversation revealed a credential")
	}
}
