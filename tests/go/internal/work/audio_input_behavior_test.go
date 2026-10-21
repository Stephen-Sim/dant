package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAudioInputUsesVerifiedRecognitionAndKeepsTheCapturedCallWhenDeliveryIsUnconfirmed(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	historical, current, _ := restoredInputAttachments(t)
	engine.options.Attachments = current
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "recognized-call", Provider: "api"}}
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-secret", "[redacted]")
	}
	engine.options.Transcribe = func(_ context.Context, file contracts.Attachment) (string, error) {
		if file.ID != historical[2].ID || file.GuestPath == historical[2].GuestPath {
			t.Fatal("recognition used stale restored attachment storage")
		}
		return "recognized fixture-secret instruction", nil
	}
	forwarded := 0
	engine.options.RecognizedCallInput = func(_ context.Context, callID string, input *contracts.ChatMessage) error {
		forwarded++
		if callID != "recognized-call" || !strings.Contains(input.Text, "recognized [redacted] instruction") || strings.Contains(input.Text, "fixture-secret") {
			t.Fatal("recognized input lost its captured media owner or was not sanitized")
		}
		return ErrUnknown
	}
	signals, unsubscribe, err := engine.SubscribeSignals()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Attachments: historical[2:]})
	if err != nil || engine.Enqueue(context.Background(), message) != nil {
		t.Fatal("verified audio was not admitted", err)
	}
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	start := nextRequest(t, worker, "turn/start")
	var input []struct{ Text string }
	if json.Unmarshal(start.params["input"], &input) != nil || len(input) != 1 || !strings.Contains(input[0].Text, "Respond to the user's voice message") || !strings.Contains(input[0].Text, "<dant_voice_message>") || strings.Contains(input[0].Text, "fixture-secret") || forwarded != 1 {
		t.Fatal("recognized audio lost its spoken-message authority or was dispatched twice")
	}
	notice := <-signals
	if notice.Type != "notice" || !strings.Contains(string(notice.Data), "will not be retried automatically") {
		t.Fatal("unconfirmed media delivery was hidden or marked safe to resend")
	}
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("recognized-audio-turn")})}}
	waitToolScope(t, engine, "recognized-audio-turn")
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Text != "" || len(stored.Attachments) != 1 || stored.Attachments[0].GuestPath != historical[2].GuestPath {
		t.Fatal("recognition rewrote the human's preserved message or historical metadata", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestAudioRecognitionFailuresStopBeforeTurnSubmissionAndDoNotInventTranscripts(t *testing.T) {
	for _, scenario := range []string{"no-recognizer", "blank-recognition", "recognition-error", "cancelled-recognition"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			historical, current, _ := restoredInputAttachments(t)
			engine.options.Attachments = current
			if scenario != "no-recognizer" {
				engine.options.Transcribe = func(ctx context.Context, _ contracts.Attachment) (string, error) {
					switch scenario {
					case "blank-recognition":
						return " \n\t", nil
					case "recognition-error":
						return "", errors.New("isolated_audio_failure")
					default:
						engine.mu.Lock()
						cancel := engine.active.cancelPreparation
						engine.mu.Unlock()
						cancel()
						return "must not be submitted after cancellation", nil
					}
				}
			}
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Attachments: historical[2:]})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("audio fixture was not durably admitted", err)
			}
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			waitSnapshot(t, engine, func(state Snapshot) bool { return state.Active == nil && len(state.Queue) == 0 })
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Text != "" || stored.UnknownOutcome || stored.Submission.Value == contracts.SubmissionStatusSubmitting || len(persistence.Snapshot().Messages) != 1 {
				t.Fatal("failed recognition fabricated input, a transcript or a submitted turn", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
