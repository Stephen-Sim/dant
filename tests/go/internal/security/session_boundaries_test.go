package security

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionAuthValidatesConfigurationAndKeepsUpgradeOriginsAndTokensExact(t *testing.T) {
	for _, input := range []struct {
		mode     string
		api, dev int
	}{
		{"other", 4317, 4318}, {"worker", 0, 4318}, {"controller", 4317, 65536},
	} {
		if _, err := NewSessionAuth(input.mode, input.api, input.dev); err == nil {
			t.Fatal("invalid native transport configuration was accepted")
		}
	}
	if _, err := NewSessionAuth("worker", 4317, 4318, SessionBuild{}, SessionBuild{}); err == nil {
		t.Fatal("ambiguous source provenance was accepted")
	}
	auth, err := NewSessionAuth("worker", 4317, 4318)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"HTTP://localhost", "http://localhost?", "https://localhost:443", "http://localhost:04317", "http://localhost/%ZZ", "http://localhost/#fragment", "http://localhost/", "http://user@localhost", "http:opaque", "http://[::1]:4317"} {
		if auth.AllowedOrigin(origin) {
			t.Fatal("noncanonical local origin was accepted")
		}
	}
	for _, fixture := range []struct {
		host, origin, query string
		want                bool
	}{
		{"localhost", "", "token=" + auth.token, true},
		{"127.0.0.1:4317", "http://localhost:4318", "token=" + auth.token, true},
		{"localhost", "http://tauri.localhost", "token=" + auth.token, true},
		{"localhost", "tauri://localhost", "token=" + auth.token, true},
		{"localhost", "https://localhost:4318", "token=" + auth.token, false},
		{"remote.invalid", "", "token=" + auth.token, false},
		{"localhost", "", "token=%ZZ", false},
		{"localhost", "", "token=" + auth.token + "&token=" + auth.token, false},
	} {
		request := httptest.NewRequest("GET", "http://localhost/events?"+fixture.query, nil)
		request.Host = fixture.host
		request.Header.Set("Origin", fixture.origin)
		if auth.CheckUpgrade(request) != fixture.want {
			t.Fatal("websocket origin or exact query-token binding changed")
		}
	}
	request := httptest.NewRequest("GET", "http://localhost/events?token="+auth.token, nil)
	request.Header.Add("Origin", "http://localhost:4317")
	request.Header.Add("Origin", "http://localhost:4317")
	if auth.CheckUpgrade(request) {
		t.Fatal("ambiguous upgrade origin was accepted")
	}
	request = httptest.NewRequest("GET", "http://localhost/api/state?token="+auth.token, nil)
	if auth.CheckToken(request, false) || !auth.CheckToken(request, true) {
		t.Fatal("query token policy was ignored")
	}
	request.Header.Set("X-Dant-Token", auth.token)
	if !auth.CheckToken(request, false) {
		t.Fatal("exact authenticated header was rejected")
	}
	handler := auth.Middleware(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { writer.WriteHeader(200) }), func(request *http.Request) bool { return request.Header.Get("X-Synthetic-Bridge") == "owned" })
	request = httptest.NewRequest("OPTIONS", "http://localhost/api/state", nil)
	request.Header.Set("Origin", "http://localhost:4318")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 204 || strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), BackupPassphraseHeader) {
		t.Fatal("worker CORS policy admitted a controller-only credential header")
	}
	request = httptest.NewRequest("POST", "http://localhost/api/internal/credentials", nil)
	request.Header.Set("X-Synthetic-Bridge", "owned")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal("exact owner-scoped credential bridge was rejected")
	}
}
