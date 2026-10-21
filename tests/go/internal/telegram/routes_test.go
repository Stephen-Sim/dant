package telegram

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTelegramRoutesStrictBooleanAndNoSecretStatus(t *testing.T) {
	fixture := fixture(t)
	mux := http.NewServeMux()
	RegisterRoutes(mux, fixture.Gateway)
	for _, body := range []string{`{"enabled":"true"}`, `{"combineReplies":null}`, `{"unknown":true}`} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/telegram/config", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, request)
		if response.Code != 400 || fixture.Sent.Load() != 0 {
			t.Fatal("invalid setting crossed feature boundary")
		}
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/telegram", nil))
	if response.Code != 200 || strings.Contains(response.Body.String(), fixtureToken) || !strings.Contains(response.Body.String(), `"forwardMode":"unread"`) {
		t.Fatal("public Telegram status changed or leaked token")
	}
	response = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/telegram/disconnect", strings.NewReader(`{"clearToken":"false"}`))
	mux.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatal("disconnect coerced an external boolean")
	}
}
