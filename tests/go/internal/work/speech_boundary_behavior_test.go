package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestSpokenReferenceReceiptsFollowTheActualTransportOutcomeWithoutReplay(t *testing.T) {
	for _, outcome := range []string{"accepted", "rejected", "unknown", "missing receipt", "receipt write failed"} {
		t.Run(outcome, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				for _, encoded := range state.VoiceHistory {
					var receipt spokenReference
					if json.Unmarshal(encoded, &receipt) == nil && receipt.Status == contracts.SpokenReferenceStatusSubmitted {
						return true
					}
				}
				return false
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "speech-boundary-call", Provider: "api"}}
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				state.VoiceHistory = []json.RawMessage{raw(7), raw(contracts.RawObject{"callId": raw("older-call")})}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			input := SpeechInput{CallID: "speech-boundary-call", ItemID: "spoken-boundary-item", Role: contracts.RoleUser, Text: "Synthetic spoken reference"}
			done := make(chan error, 1)
			go func() { done <- engine.RecordSpeech(t.Context(), input) }()
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			injection := nextRequest(t, worker, "thread/inject_items")
			response := fakeResponse{value: contracts.RawObject{}}
			want := contracts.SpokenReferenceStatusSubmitted
			switch outcome {
			case "rejected":
				response.err = &runtime.OperationError{Cause: errors.New("isolated reference rejection")}
				want = contracts.SpokenReferenceStatusFailed
			case "unknown":
				response.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
				want = contracts.SpokenReferenceStatusUnknown
			case "missing receipt":
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					state.VoiceHistory = []json.RawMessage{raw(7)}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			case "receipt write failed":
				fault.armed.Store(true)
				want = contracts.SpokenReferenceStatusPending
			}
			injection.result <- response
			err := awaitWorkAction(t, done)
			if outcome == "accepted" && err != nil || outcome == "receipt write failed" && !errors.Is(err, store.ErrPersistence) || outcome != "accepted" && outcome != "receipt write failed" && !errors.Is(err, ErrSpeechUnconfirmed) {
				t.Fatal("spoken receipt did not preserve its actual acknowledgement", err)
			}
			state := persistence.Snapshot()
			if outcome != "missing receipt" {
				var receipt spokenReference
				if len(state.VoiceHistory) != 3 || json.Unmarshal(state.VoiceHistory[2], &receipt) != nil || receipt.Status != want || receipt.ItemID != input.ItemID || receipt.Text != input.Text {
					t.Fatal("spoken receipt lost its identity or uncertainty")
				}
				if err := engine.RecordSpeech(t.Context(), input); outcome == "accepted" && err != nil || outcome != "accepted" && !errors.Is(err, ErrSpeechUnconfirmed) {
					t.Fatal("stored speech was replayed or accepted without confirmation", err)
				}
			}
			if len(state.Messages) != 0 || engine.Snapshot().Active != nil {
				t.Fatal("speech reference created visible chat or an execution")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestSpokenReferenceRejectsInvalidAndReplacedMediaBeforeSubmission(t *testing.T) {
	engine, _, worker := engineFixture(t)
	valid := SpeechInput{CallID: "speech-validation-call", ItemID: "speech-validation-item", Role: contracts.RoleUser, Text: "Synthetic speech"}
	for _, input := range []SpeechInput{
		{},
		{CallID: valid.CallID, ItemID: valid.ItemID, Role: contracts.RoleSystem, Text: valid.Text},
		{CallID: valid.CallID, ItemID: valid.ItemID, Role: valid.Role, Text: " \t"},
	} {
		if err := engine.RecordSpeech(context.Background(), input); !errors.Is(err, store.ErrInvalidState) {
			t.Fatal("invalid speech entered durable reference admission", err)
		}
	}
	if err := engine.RecordSpeech(t.Context(), valid); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("speech without its captured media owner reached transport", err)
	}
	assertWorkerQuiet(t, worker)
}
