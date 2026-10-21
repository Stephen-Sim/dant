package security

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
)

func credentialRoute(t *testing.T, mux *http.ServeMux, method, target, body string, status int) []byte {
	t.Helper()
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(method, target, strings.NewReader(body)))
	if response.Code != status {
		t.Fatalf("credential route %s %s: got %d, want %d", method, target, response.Code, status)
	}
	return response.Body.Bytes()
}

func TestCredentialHTTPRoutesKeepSecretsPrivateAndPreserveCRUDIdentity(t *testing.T) {
	vault, err := NewVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	requests := NewCredentialRequests(vault, nil)
	t.Cleanup(requests.Close)
	mux := http.NewServeMux()
	RegisterCredentialRoutes(mux, requests)
	created := credentialRoute(t, mux, "POST", "/api/credentials", `{"name":"Synthetic route","service":"fixture.invalid","username":"synthetic","secret":"synthetic-route-secret"}`, 200)
	var metadata CredentialMetadata
	if json.Unmarshal(created, &metadata) != nil || metadata.ID == "" || bytes.Contains(created, []byte("synthetic-route-secret")) {
		t.Fatal("credential route omitted its stable identity or returned the stored secret")
	}
	updated := credentialRoute(t, mux, "PATCH", "/api/credentials/"+metadata.ID, `{"id":"other-body-id","name":"Renamed route"}`, 200)
	var changed CredentialMetadata
	if json.Unmarshal(updated, &changed) != nil || changed.ID != metadata.ID || changed.Name != "Renamed route" {
		t.Fatal("path identity did not own the credential update")
	}
	listed := credentialRoute(t, mux, "GET", "/api/credentials", "", 200)
	if bytes.Contains(listed, []byte("synthetic-route-secret")) || !bytes.Contains(listed, []byte(metadata.ID)) {
		t.Fatal("credential inventory changed identity or exposed private input")
	}
	if entries, err := requests.Find(t.Context(), "RENAMED"); err != nil || len(entries) != 1 || entries[0].ID != metadata.ID {
		t.Fatal("credential search did not delegate to the owning repository", err)
	}
	if secret, err := requests.Get(t.Context(), metadata.ID); err != nil || secret.Secret != "synthetic-route-secret" {
		t.Fatal("credential retrieval changed the stored input", err)
	}
	if found, err := requests.ContainsSecret(t.Context(), "prefix synthetic-route-secret"); err != nil || !found {
		t.Fatal("credential disclosure guard missed a stored secret", err)
	}
	if redacted, err := requests.Redact(t.Context(), "synthetic-route-secret additional-fixture", false, []string{"additional-fixture"}); err != nil || redacted != RedactedCredential+" "+RedactedCredential {
		t.Fatal("credential redaction did not include caller-scoped private input", err)
	}
	removed := credentialRoute(t, mux, "DELETE", "/api/credentials/"+metadata.ID, "", 200)
	if !bytes.Contains(removed, []byte(`"removed":true`)) {
		t.Fatal("credential removal did not return a confirmed result")
	}
	for _, fixture := range []struct{ method, target, body string }{
		{"POST", "/api/credentials", `{`},
		{"POST", "/api/credentials", `{"secret":false}`},
		{"POST", "/api/credentials", `{"name":"No secret"}`},
		{"PATCH", "/api/credentials/invalid-id", `{"name":"invalid"}`},
		{"DELETE", "/api/credentials/" + metadata.ID, ""},
		{"DELETE", "/api/credentials/requests/missing", ""},
		{"POST", "/api/credentials/requests/missing", `{"secret":"synthetic"}`},
		{"POST", "/api/credentials/requests/missing", `false`},
	} {
		body := credentialRoute(t, mux, fixture.method, fixture.target, fixture.body, 400)
		if bytes.Contains(body, []byte("synthetic-route-secret")) || bytes.Contains(body, []byte(vault.directory)) {
			t.Fatal("credential failure exposed private data")
		}
	}
}

func TestCredentialHTTPRequestsFulfillExistingIdentityOrCancelTheirExactOwner(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, err := NewVault(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		original, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Existing"), Service: stringPointer("service"), Username: stringPointer("user"), Secret: stringPointer("old-synthetic-secret")})
		if err != nil {
			t.Fatal(err)
		}
		requests := NewCredentialRequests(vault, nil)
		t.Cleanup(requests.Close)
		mux := http.NewServeMux()
		RegisterCredentialRoutes(mux, requests)
		finished := make(chan error, 1)
		go func() {
			_, err := requests.Request(t.Context(), RequestInput{Name: "Existing", Service: "service"}, "synthetic-owner", func() bool { return true })
			finished <- err
		}()
		synctest.Wait()
		snapshot := requests.Snapshot(t.Context())
		if len(snapshot.Requests) != 1 {
			t.Fatal("secure form did not become visible")
		}
		result := credentialRoute(t, mux, "POST", "/api/credentials/requests/"+snapshot.Requests[0].ID, `{"username":"user","secret":"new-synthetic-secret"}`, 200)
		if err := <-finished; err != nil || !bytes.Contains(result, []byte(original.ID)) || bytes.Contains(result, []byte("new-synthetic-secret")) {
			t.Fatal("fulfilled form changed its stored identity or exposed the secret", err)
		}
		stored, err := vault.Get(t.Context(), original.ID)
		if err != nil || stored.Secret != "new-synthetic-secret" {
			t.Fatal("secure form did not update the user's selected credential", err)
		}
		go func() {
			_, err := requests.Request(t.Context(), RequestInput{Name: "Cancel this form"}, "cancel-owner", func() bool { return true })
			finished <- err
		}()
		synctest.Wait()
		snapshot = requests.Snapshot(t.Context())
		if len(snapshot.Requests) != 1 {
			t.Fatal("second secure form did not become visible")
		}
		credentialRoute(t, mux, "DELETE", "/api/credentials/requests/"+snapshot.Requests[0].ID, "", 200)
		if err := <-finished; !errors.Is(err, ErrCredentialCancelled) {
			t.Fatal("cancelled form delivered a successful receipt", err)
		}
	})
}

func TestCredentialRequestAdmissionAndCancellationRemainBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, err := NewVault(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		requests := NewCredentialRequests(vault, nil)
		t.Cleanup(requests.Close)
		cancelled, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := requests.Request(cancelled, RequestInput{Name: "Cancelled"}, "owner", func() bool { return true }); !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled form was admitted", err)
		}
		for _, fixture := range []struct {
			input   RequestInput
			owner   string
			current func() bool
			want    error
		}{
			{RequestInput{Name: "Synthetic"}, "", func() bool { return true }, ErrCredentialInactive},
			{RequestInput{Name: "Synthetic"}, "owner", nil, ErrCredentialInactive},
			{RequestInput{Name: "Synthetic"}, "owner", func() bool { return false }, ErrCredentialInactive},
			{RequestInput{Name: ""}, "owner", func() bool { return true }, ErrCredential},
		} {
			if _, err := requests.Request(t.Context(), fixture.input, fixture.owner, fixture.current); !errors.Is(err, fixture.want) {
				t.Fatal("invalid form admission changed", err)
			}
		}
		finished := make(chan error, PendingCredentialLimit)
		for index := range PendingCredentialLimit {
			name := strings.Repeat("x", index+1)
			go func() {
				_, err := requests.Request(t.Context(), RequestInput{Name: name}, "owner", func() bool { return true })
				finished <- err
			}()
		}
		synctest.Wait()
		if _, err := requests.Request(t.Context(), RequestInput{Name: "over capacity"}, "owner", func() bool { return true }); !errors.Is(err, ErrCredentialRequestLimit) {
			t.Fatal("secure form capacity was not bounded", err)
		}
		requests.CancelOwner("unrelated-owner")
		if len(requests.Snapshot(t.Context()).Requests) != PendingCredentialLimit {
			t.Fatal("unrelated owner cancelled secure forms")
		}
		requests.CancelOwner("owner")
		for range PendingCredentialLimit {
			if err := <-finished; !errors.Is(err, ErrCredentialCancelled) {
				t.Fatal("cancelled owner received credentials", err)
			}
		}
		requests.Close()
		if _, err := requests.Request(t.Context(), RequestInput{Name: "after close"}, "owner", func() bool { return true }); !errors.Is(err, ErrCredentialInactive) {
			t.Fatal("closed secure form collection admitted a request", err)
		}
	})
}
