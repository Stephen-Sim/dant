package voice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestNativeServiceDeliversQuotedInputThroughItsConfiguredProvider(t *testing.T) {
	native, worker, _, persistence := nativeFixture(t)
	service := NewService(ServiceOptions{Native: native})
	startNativeFixture(t, native)
	quoted, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "Synthetic result to quote"})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service})
	body, err := json.Marshal(contracts.RawObject{"callId": rawValue("call-one"), "clientMessageId": rawValue("service-quoted-input"), "text": rawValue("Explain this result"), "replyTo": rawValue(quoted.ID)})
	if err != nil {
		t.Fatal(err)
	}
	if response := voiceRequest(mux, "POST", "/api/realtime/message", string(body)); response.Code != http.StatusOK {
		t.Fatal("native input route did not deliver its quoted user request", response.Code)
	}
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic second input"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Message(t.Context(), MessageOptions{CallID: "call-one", Message: message})
	if err != nil || result.MessageID != message.ID || result.Submission != contracts.SubmissionStatusConfirmed || worker.appendCalls.Load() != 2 {
		t.Fatal("service input facade lost its exact native confirmation", err)
	}
	state := service.NativeState()
	if state.Call == nil || state.Call.ID != "call-one" {
		t.Fatal("native state facade lost its connected media owner")
	}
	if err := service.HandleEvent(t.Context(), runtime.Event{Method: "thread/realtime/notice", Params: contracts.RawObject{"threadId": rawValue("foreign-thread")}}); err != nil {
		t.Fatal(err)
	}
	if err := service.PauseWork(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := service.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestAPIServiceForwardsAcknowledgedMemoryAndSharedReferenceUpdates(t *testing.T) {
	api, socket, _ := apiFixture(t, APIOptions{})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "session.update" {
			socket.emit(contracts.RawObject{"type": rawValue("session.updated"), "session": event["session"]})
		}
	}
	startAPIFixture(t, api)
	service := NewService(ServiceOptions{API: api})
	if result := service.SyncMemory(t.Context(), "fixture-call", "Synthetic durable memory"); result.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("service lost the API memory acknowledgement", result)
	}
	if result := service.SyncContext(t.Context(), "fixture-call", "message", &contracts.ChatMessage{ID: "shared-message", Role: contracts.RoleAssistant, Text: "Synthetic shared result"}); result.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("service lost the API live-reference acknowledgement", result)
	}
	if _, err := service.StartCall(t.Context(), CallStartRequest{SDP: fixtureSDP, Provider: "api"}); !errors.Is(err, ErrVoiceBusy) {
		t.Fatal("connected service admitted a second media owner", err)
	}
	service.starting = true
	called := false
	if err := service.changeKey(func() error { called = true; return nil }); !errors.Is(err, ErrVoiceBusy) || called {
		t.Fatal("credential write crossed a call-start reservation", err)
	}
	service.starting = false
}

func TestNativeServiceStartAndVoiceDiscoveryFailuresKeepTheirProviderClassification(t *testing.T) {
	native, worker, _, _ := nativeFixture(t)
	service := NewService(ServiceOptions{Native: native})
	if _, err := service.Start(t.Context(), contracts.RawObject{"sdp": json.RawMessage(`invalid JSON`)}); !errors.Is(err, ErrCallInput) {
		t.Fatal("unencodable start input reached provider setup", err)
	}
	if _, err := service.StartCall(t.Context(), CallStartRequest{SDP: "invalid SDP", Provider: "subscription", CallID: "failed-native-call"}); !errors.Is(err, ErrCallInput) || service.Snapshot() != nil {
		t.Fatal("failed native call appeared connected", err)
	}
	failure := errors.New("isolated voice discovery failure")
	native.options.Worker = nativeStartWorkerBoundary{Worker: worker, request: func(context.Context, string, contracts.RawObject) (contracts.RawObject, error) { return nil, failure }}
	if _, err := service.Voices(t.Context()); !errors.Is(err, failure) {
		t.Fatal("voice-list facade lost a provider failure", err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: service})
	if response := voiceRequest(mux, "POST", "/api/call", `{"sdp":"invalid SDP"}`); response.Code != http.StatusBadRequest {
		t.Fatal("invalid provider start returned a successful route response", response.Code)
	}
	if response := voiceRequest(mux, "GET", "/api/voices", ""); response.Code == http.StatusOK {
		t.Fatal("failed provider voice list returned success")
	}
}

func TestVoiceCaptionFacadePreservesCurrentCallAndSequence(t *testing.T) {
	state := NewCaptionState(nil)
	state.Sync(&contracts.Call{ID: "caption-facade-call", Provider: "api", Status: contracts.VoiceCallStatusConnected}, "caption-fixture-scope", true)
	encoded := rawValue(Caption{CallID: "caption-facade-call", Provider: "api", Sequence: 1, Text: "Synthetic caption", Final: true})
	caption := ReadCaption(encoded)
	if caption == nil || !state.Observe(*caption) || state.Snapshot().Text != "Synthetic caption" || state.Observe(*caption) {
		t.Fatal("caption facade lost current-call ownership or accepted a repeated sequence")
	}
}
