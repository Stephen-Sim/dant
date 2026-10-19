package captions

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func apiEvent(raw string) contracts.RawObject {
	value, _ := contracts.DecodeObject([]byte(raw), 2*1024*1024)
	return value
}
func TestSubtitlesFenceResponsePartsCompletionAndCredentialRedaction(t *testing.T) {
	s := NewSubtitles("call-a", "api", func(text string) string { return strings.ReplaceAll(text, "fixture-secret", "[omitted]") })
	s.API(apiEvent(`{"type":"response.created","response":{"id":"response-a"}}`))
	value := s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response-a","item_id":"item-a","delta":"spoken fixture-secret","content_index":0}`))
	if value == nil || value.Text != "spoken [omitted]" || value.Final {
		t.Fatal("caption leaked or missing")
	}
	if s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response-old","item_id":"item-a","delta":"stale"}`)) != nil {
		t.Fatal("stale response appended")
	}
	if s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response-a","item_id":"different","delta":"wrong","content_index":0}`)) != nil {
		t.Fatal("same-order item replacement accepted")
	}
	if s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response-a","item_id":"item-a","delta":"wrong","content_index":null}`)) != nil {
		t.Fatal("null content index defaulted")
	}
	value = s.API(apiEvent(`{"type":"response.done","response":{"id":"response-a","status":"completed"}}`))
	if value == nil || !value.Final || s.Snapshot().Text != "spoken [omitted]" {
		t.Fatal("completed last caption not retained")
	}
	s.API(apiEvent(`{"type":"response.created","response":{"id":"response-a"}}`))
	if s.Snapshot().Text != "spoken [omitted]" {
		t.Fatal("retired response revived")
	}
	value = s.API(apiEvent(`{"type":"input_audio_buffer.speech_started"}`))
	if value == nil || value.Text != "" || value.Final {
		t.Fatal("new human speech did not clear assistant caption")
	}
}
func TestCaptionStateScopeDisconnectHighWaterAndNoPersistence(t *testing.T) {
	s := NewCaptionState(func(text string) string { return strings.ReplaceAll(text, "private", "[omitted]") })
	call := &contracts.Call{ID: "call", Provider: "subscription", Status: "connected"}
	s.Sync(call, "conversation/binding", true)
	value := Caption{"call", "subscription", 2, "private spoken", true}
	if !s.Observe(value) || s.Snapshot().Text != "[omitted] spoken" {
		t.Fatal("live caption missing")
	}
	snapshot := s.Snapshot()
	snapshot.Text = "outside mutation"
	if s.Snapshot().Text == snapshot.Text {
		t.Fatal("snapshot pointer escaped")
	}
	s.Sync(call, "conversation/binding", false)
	if s.Snapshot() != nil {
		t.Fatal("disconnected caption retained")
	}
	s.Sync(call, "conversation/binding", true)
	if s.Observe(value) {
		t.Fatal("cached prior sequence restored old text")
	}
	value.Sequence = 3
	if !s.Observe(value) {
		t.Fatal("fresh observation rejected")
	}
	call.Status = "ended"
	s.Sync(call, "conversation/binding", true)
	call.Status = "connected"
	s.Sync(call, "conversation/binding", true)
	value.Sequence = 4
	if s.Observe(value) {
		t.Fatal("ended call revived")
	}
	s.Sync(call, "different-conversation/binding", true)
	if !s.Observe(value) {
		t.Fatal("new scope did not reset retired set")
	}
	raw, _ := json.Marshal(call)
	if strings.Contains(string(raw), "spoken") {
		t.Fatal("caption mutated persisted call")
	}
	if ReadCaption(json.RawMessage(`{"callId":"call","provider":"api","sequence":1,"text":"x","final":null}`)) != nil {
		t.Fatal("null final coerced")
	}
}
func TestNativeCaptionsAssistantOnlyBoundedAndFinalRemainsUntilClear(t *testing.T) {
	s := NewSubtitles("call", "subscription", nil)
	if s.Native("thread/realtime/transcript/delta", object(map[string]any{"role": "system", "delta": "never"})) != nil {
		t.Fatal("invented role emitted")
	}
	value := s.Native("thread/realtime/transcript/done", object(map[string]any{"role": "assistant", "text": strings.Repeat("😀", 3000)}))
	if value == nil || !value.Final || contracts.UTF16Length(value.Text) > CaptionTextLimit {
		t.Fatal("caption not bounded")
	}
	if s.Native("thread/realtime/transcript/done", object(map[string]any{"role": "assistant", "text": strings.Repeat("😀", 3000)})) != nil {
		t.Fatal("duplicate caption emitted")
	}
	if value = s.Native("thread/realtime/transcript/delta", object(map[string]any{"role": "user", "delta": "private human speech"})); value == nil || value.Text != "" {
		t.Fatal("human event did not clear old assistant caption")
	}
}
