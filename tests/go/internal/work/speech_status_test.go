package work

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestSpeechReceiptsKeepTheirOwnStatusDomainAndNeverReplayUnknownRecords(t *testing.T) {
	cases := []struct {
		name      string
		status    json.RawMessage
		confirmed bool
	}{
		{"submitted", json.RawMessage(`"submitted"`), true},
		{"pending", json.RawMessage(`"pending"`), false},
		{"unknown", json.RawMessage(`"unknown"`), false},
		{"failed", json.RawMessage(`"failed"`), false},
		{"future-status", json.RawMessage(`"future-receipt"`), false},
		{"task-status-is-not-a-speech-receipt", json.RawMessage(`"completed"`), false},
		{"omitted-status", nil, false},
		{"null-status", json.RawMessage(`null`), false},
		{"wrong-status-shape", json.RawMessage(`true`), false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "receipt-call", Provider: "api"}}
			entry := contracts.RawObject{
				"callId": raw("receipt-call"), "itemId": raw("spoken-item"),
				"role": raw(contracts.RoleUser), "text": raw("Recorded speech"), "at": raw(12),
			}
			if test.status != nil {
				entry["status"] = test.status
			}
			before := raw(entry)
			if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
				state.VoiceHistory = []json.RawMessage{before}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			err := engine.RecordSpeech(context.Background(), SpeechInput{
				CallID: "receipt-call", ItemID: "spoken-item", Role: contracts.RoleUser, Text: "Recorded speech",
			})
			if test.confirmed && err != nil || !test.confirmed && !errors.Is(err, ErrSpeechUnconfirmed) {
				t.Fatalf("speech receipt confirmation changed: %v", err)
			}
			after := persistence.Snapshot().VoiceHistory
			if len(after) != 1 || !bytes.Equal(before, after[0]) {
				t.Fatal("an uncertain or already submitted receipt was rewritten")
			}
			select {
			case <-worker.requests:
				t.Fatal("a stored speech receipt was automatically replayed")
			default:
			}
		})
	}
}
