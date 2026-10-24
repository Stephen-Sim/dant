package voice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type scopedAddRace struct {
	NativePersistence
	before func()
}

func (race scopedAddRace) AddConversation(ctx context.Context, conversation string, message *contracts.ChatMessage) (*contracts.ChatMessage, error) {
	race.before()
	return race.NativePersistence.AddConversation(ctx, conversation, message)
}

func TestNativeMessageConversationScopeRejectsWrongInputAndPreservesLegacyOmission(t *testing.T) {
	native, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, native)
	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Service: NewService(ServiceOptions{Native: native})})
	conversation := persistence.ConversationID()
	for _, encoded := range []string{`null`, `false`, `12`, `[]`, `""`, `"\ud800"`, `"` + strings.Repeat("x", nativeConversationIDLimit+1) + `"`} {
		response := voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"call-one","clientMessageId":"scope-input","text":"Authored request","conversationId":`+encoded+`}`)
		if response.Code != 400 {
			t.Fatal("invalid optional conversation scope was accepted", response.Code)
		}
	}
	response := voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"call-one","clientMessageId":"scope-input","text":"Authored request","conversationId":"retired-conversation"}`)
	if response.Code != 409 || worker.appendCalls.Load() != 0 || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("wrong conversation reached persistence or the model")
	}
	response = voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"call-one","clientMessageId":"scope-input","text":"Authored request","conversationId":"`+conversation+`"}`)
	if response.Code != 200 || worker.appendCalls.Load() != 1 || persistence.ConversationID() != conversation {
		t.Fatal("exact conversation scope was not accepted", response.Code)
	}
	legacy := voiceRequest(mux, http.MethodPost, "/api/realtime/message", `{"callId":"call-one","clientMessageId":"legacy-input","text":"Legacy authored request"}`)
	if legacy.Code != 200 || worker.appendCalls.Load() != 2 || persistence.ConversationID() != conversation {
		t.Fatal("omitted legacy scope invented an identity or failed", legacy.Code)
	}
	var result NativeMessageResult
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Message.Text != "Authored request" {
		t.Fatal("scoped response lost its actual message")
	}
}

func TestNativeMessageConversationChangeAtCommitCannotAppendIntoReplacementChat(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		native, worker, _, persistence := nativeFixture(t)
		startNativeFixture(t, native)
		conversation := persistence.ConversationID()
		native.options.Store = scopedAddRace{NativePersistence: persistence, before: func() {
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				state.ConversationID = "23b9bcec-701c-47c4-999d-40292e3f4264"
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		}}
		input := NativeMessage{CallID: "call-one", ClientMessageID: "race-input", Text: "Do not deliver into the replacement"}
		if explicit {
			input.ConversationID = &conversation
		}
		if _, err := native.Message(t.Context(), input); !errors.Is(err, ErrVoiceCancelled) || worker.appendCalls.Load() != 0 || len(persistence.Snapshot().Messages) != 0 {
			t.Fatal("retired admission crossed the atomic persistence boundary", explicit, err)
		}
	}
}

func TestNativeMessageLateReferenceCannotPatchOrSubmitIntoReplacementConversation(t *testing.T) {
	native, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, native)
	conversation := persistence.ConversationID()
	native.options.RememberCallInput = func(context.Context, *contracts.ChatMessage, string) error {
		return persistence.Mutate(t.Context(), func(state *contracts.State) error {
			state.ConversationID = "23b9bcec-701c-47c4-999d-40292e3f4264"
			return nil
		})
	}
	_, err := native.Message(t.Context(), NativeMessage{CallID: "call-one", ClientMessageID: "late-reference-input", Text: "Retired reference", ConversationID: &conversation})
	state := persistence.Snapshot()
	if err == nil || worker.appendCalls.Load() != 0 || len(state.Messages) != 1 || state.Messages[0].Submission.Value != contracts.SubmissionStatusPreparing || state.Messages[0].ExecutorConfirmedAt.Value != 0 {
		t.Fatal("late reference crossed the conversation fence", err)
	}
}
