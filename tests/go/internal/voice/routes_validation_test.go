package voice

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/security"
)

type routeKeyFixture struct {
	sets, clears int
	err          error
}

func (keys *routeKeyFixture) Set(context.Context, string) (security.KeyStatus, error) {
	keys.sets++
	return security.KeyStatus{}, keys.err
}
func (keys *routeKeyFixture) Clear(context.Context) (security.KeyStatus, error) {
	keys.clears++
	return security.KeyStatus{}, keys.err
}

func TestVoiceRouteValidationNeverStartsProvidersOrChangesKeys(t *testing.T) {
	native, worker, _, _ := nativeFixture(t)
	keys := &routeKeyFixture{}
	service := NewService(ServiceOptions{Native: native})
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service, Keys: keys})
	for _, test := range []struct{ path, body string }{
		{"/api/call", `{`}, {"/api/call", `{}`}, {"/api/call", `{"sdp":"offer","provider":false}`}, {"/api/call", `{"sdp":"offer","apiKey":false}`}, {"/api/call", `{"sdp":"offer","apiKey":"fixture"}`}, {"/api/call", `{"sdp":"offer","provider":"api","apiKey":"bad"}`},
		{"/api/call/connected", `{`}, {"/api/call/connected", `{}`},
		{"/api/call/stop", `{`}, {"/api/call/stop", `{"callId":false}`},
		{"/api/realtime/message", `{`}, {"/api/realtime/message", `{}`}, {"/api/realtime/message", `{"callId":"call","clientMessageId":"message","text":"request","replyTo":false}`},
		{"/api/voice-key", `{`}, {"/api/voice-key", `{}`},
	} {
		if response := voiceRequest(mux, "POST", test.path, test.body); response.Code != 400 {
			t.Fatalf("invalid request %s returned %d", test.path, response.Code)
		}
	}
	if len(worker.requests) != 0 || keys.sets != 0 || keys.clears != 0 {
		t.Fatal("invalid request crossed a provider boundary")
	}
	if response := voiceRequest(mux, "POST", "/api/call/stop", `{}`); response.Code != 200 {
		t.Fatal("stopping no current call was not idempotent")
	}
	if response := voiceRequest(mux, "POST", "/api/call/connected", `{"callId":"missing"}`); response.Code != 409 {
		t.Fatal("missing current call was acknowledged")
	}
}

func TestVoiceKeyRoutesPublishOnlyCommittedChangesAndRefuseActiveCalls(t *testing.T) {
	native, _, _, _ := nativeFixture(t)
	keys := &routeKeyFixture{}
	changed := 0
	service := NewService(ServiceOptions{Native: native})
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service, Keys: keys, Changed: func() { changed++ }})
	for _, method := range []string{"POST", "DELETE"} {
		if response := voiceRequest(mux, method, "/api/voice-key", `{"key":"fixture-only-key"}`); response.Code != 200 {
			t.Fatal("isolated committed key mutation failed", response.Code)
		}
	}
	if changed != 2 || keys.sets != 1 || keys.clears != 1 {
		t.Fatal("committed key changes did not publish exactly once")
	}
	keys.err = security.ErrAPIKey
	if response := voiceRequest(mux, "POST", "/api/voice-key", `{"key":"fixture-only-key"}`); response.Code != 400 || changed != 2 {
		t.Fatal("failed key save reported a committed change")
	}
	if response := voiceRequest(mux, "DELETE", "/api/voice-key", ""); response.Code != 400 || changed != 2 {
		t.Fatal("failed key clear reported a committed change")
	}
	keys.err = nil
	startNativeFixture(t, native)
	for _, method := range []string{"POST", "DELETE"} {
		if response := voiceRequest(mux, method, "/api/voice-key", `{"key":"fixture-only-key"}`); response.Code != 409 || changed != 2 {
			t.Fatal("active call allowed changing provider credentials")
		}
	}
	if response := voiceRequest(mux, "GET", "/api/voices", ""); response.Code != 200 {
		t.Fatal("fixture provider voice list was unavailable")
	}
	if response := voiceRequest(mux, "POST", "/api/call/stop", `{"callId":"other"}`); response.Code != 409 || service.Snapshot() == nil {
		t.Fatal("stale stop affected current call")
	}
	if err := native.Stop(t.Context(), "call-one"); err != nil {
		t.Fatal(err)
	}
	for _, failure := range []error{ErrVoiceConnection, ErrVoiceKey} {
		if err := voiceRouteError(failure); err == failure {
			t.Fatal("provider failure escaped classification")
		}
	}
	unknown := errors.New("isolated unknown result")
	if voiceRouteError(unknown) != unknown {
		t.Fatal("unclassified result was invented as success")
	}
	input := &VoiceInputError{UnknownOutcome: true}
	if voiceRouteError(input) != input || !input.UnconfirmedOutcome() {
		t.Fatal("input route lost its explicit unknown outcome")
	}
}
