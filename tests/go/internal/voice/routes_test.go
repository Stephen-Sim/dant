package voice

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func voiceRequest(mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(response, request)
	return response
}

func TestVoiceRoutesPreserveConnectedAndStopShapesAndCallIdentity(t *testing.T) {
	native, worker, _, _ := nativeFixture(t)
	service := NewService(ServiceOptions{Native: native})
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service, Ready: func() bool { return true }})
	started := voiceRequest(mux, http.MethodPost, "/api/call", `{"sdp":"v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"}`)
	var result CallStartResult
	if started.Code != 200 || json.Unmarshal(started.Body.Bytes(), &result) != nil || result.CallID == "" {
		t.Fatal("call startup response changed", started.Code)
	}
	before := worker.appendCalls.Load()
	invalid := voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"other-call","clientMessageId":"stable","text":"request"}`)
	if invalid.Code != 409 || worker.appendCalls.Load() != before {
		t.Fatal("stale call input reached executor")
	}
	connected := voiceRequest(mux, http.MethodPost, "/api/call/connected", `{"callId":"`+result.CallID+`"}`)
	var status map[string]json.RawMessage
	if connected.Code != 200 || json.Unmarshal(connected.Body.Bytes(), &status) != nil || string(status["connected"]) != "true" || len(status["connectedAt"]) == 0 {
		t.Fatal("connected response contract changed")
	}
	missing := voiceRequest(mux, http.MethodPost, "/api/call/stop", `{}`)
	if missing.Code != 400 || service.Snapshot() == nil {
		t.Fatal("missing call owner stopped current media")
	}
	stopped := voiceRequest(mux, http.MethodPost, "/api/call/stop", `{"callId":"`+result.CallID+`"}`)
	if stopped.Code != 200 || json.Unmarshal(stopped.Body.Bytes(), &status) != nil || string(status["stopped"]) != "true" {
		t.Fatal("stop response contract changed")
	}
}

func TestVoiceRouteOfflineAndInvalidFieldsHaveNoProviderEffects(t *testing.T) {
	native, worker, _, _ := nativeFixture(t)
	service := NewService(ServiceOptions{Native: native})
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service, Ready: func() bool { return false }})
	response := voiceRequest(mux, http.MethodPost, "/api/call", `{"sdp":"anything"}`)
	if response.Code != 409 || len(worker.requests) != 0 {
		t.Fatal("offline route started provider")
	}
	response = voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"one","clientMessageId":"stable","text":"request","attachments":null}`)
	if response.Code != 400 || worker.appendCalls.Load() != 0 {
		t.Fatal("invalid attachment input reached provider")
	}
}
