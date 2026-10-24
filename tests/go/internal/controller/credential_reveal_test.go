package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestControllerForwardsExplicitCredentialRevealWithoutCachingOrBroadcastingSecret(t *testing.T) {
	app, bridge, _, token := controllerAppFixture(t)
	before, _ := json.Marshal(app.Snapshot())
	calls := 0
	bridge.request = func(_ context.Context, method, route string, headers http.Header, reader io.Reader) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(reader)
		if method != http.MethodPost || route != "/api/credentials/reveal/synthetic-id" || string(body) != `{"conversationId":"synthetic-conversation"}` || headers.Get("Content-Type") != "application/json" {
			t.Error("Controller changed the explicit reveal scope")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": []string{"no-store"}, "Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"synthetic-id","conversationId":"synthetic-conversation","secret":"synthetic-controller-reveal-secret"}`))}, nil
	}
	response := controllerRecordedRequest(t, app, "", http.MethodPost, "/api/credentials/reveal/synthetic-id", `{}`)
	if response.Code != 401 || calls != 0 {
		t.Fatal("unauthenticated reveal crossed the Worker boundary")
	}
	response = controllerRecordedRequest(t, app, token, http.MethodPost, "/api/credentials/reveal/synthetic-id", `{"conversationId":"synthetic-conversation"}`)
	if response.Code != 200 || calls != 1 || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), "synthetic-controller-reveal-secret") {
		t.Fatal("Controller did not forward the exact no-store reveal response")
	}
	after, _ := json.Marshal(app.Snapshot())
	if !bytes.Equal(before, after) || bytes.Contains(after, []byte("synthetic-controller-reveal-secret")) {
		t.Fatal("reveal mutated or disclosed through Controller state")
	}
}
