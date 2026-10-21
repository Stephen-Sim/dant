package captions

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestCaptionBoundaryRejectsMalformedEventsAndContainsRedactorPanics(t *testing.T) {
	for _, raw := range []string{`{`, `null`, `{"callId":"call"}`, `{"callId":"call","provider":"unknown","sequence":1,"text":"x","final":false}`, `{"callId":"call","provider":"api","sequence":0,"text":"x","final":false}`, `{"callId":"call","provider":"api","sequence":1,"text":"\u0000","final":false}`, `{"callId":"call","provider":"api","sequence":"1","text":"x","final":false}`} {
		if ReadCaption(json.RawMessage(raw)) != nil {
			t.Fatal("invalid caption was accepted")
		}
	}
	for _, id := range []string{"", "bad\x00id", strings.Repeat("x", 257)} {
		if ValidID(id) {
			t.Fatal("invalid caption owner accepted")
		}
	}
	if !ValidID("call") || !ValidText("line one\nline two\t") || ValidText("bad\x7ftext") || TailText("a😀b", 2) != "b" {
		t.Fatal("caption validation or UTF-16 tail boundary changed")
	}
	state := NewCaptionState(func(string) string { panic("isolated redactor failure") })
	state.Sync(&contracts.Call{ID: "call", Provider: "api", Status: contracts.VoiceCallStatusConnected}, "scope", true)
	raw := json.RawMessage(`{"callId":"call","provider":"api","sequence":1,"text":"private fixture","final":false}`)
	if state.Receive("foreign/event", raw) || !state.Receive(CaptionEventMethod, raw) || state.Snapshot().Text != "" {
		t.Fatal("redactor failure exposed transient speech")
	}
	state.End()
	if state.Snapshot() != nil || state.Receive(CaptionEventMethod, raw) {
		t.Fatal("ended caption state was revived")
	}
	if text := safeCaption("safe\x00text\x7f", nil); text != "safetext" {
		t.Fatal("control characters escaped caption projection")
	}
}

func TestRetiredCaptionOwnersRemainBoundedAndCannotBeDuplicated(t *testing.T) {
	retired := &retiredIDs{}
	retired.add("")
	for index := range captionRetiredLimit + 1 {
		retired.add(fmt.Sprintf("call-%d", index))
	}
	retired.add("call-1")
	if len(retired.order) != captionRetiredLimit || retired.has("call-0") || !retired.has("call-1") {
		t.Fatal("retired owner history was not bounded or deduplicated")
	}
	retired.clear()
	if len(retired.order) != 0 || retired.has("call-1") {
		t.Fatal("new scope retained retired call owners")
	}
}

func TestSubtitleProviderOrderingRejectsInvalidPartsAndClearsFailedResponses(t *testing.T) {
	s := NewSubtitles("call", "api", nil)
	s.API(apiEvent(`{"type":"response.created","response":{"id":"response"}}`))
	for _, raw := range []string{
		`{"type":"response.output_audio_transcript.delta","response_id":"response","item_id":"item","output_index":null,"delta":"bad"}`,
		`{"type":"response.output_audio_transcript.delta","response_id":"response","item_id":"item","content_index":129,"delta":"bad"}`,
	} {
		if s.API(apiEvent(raw)) != nil {
			t.Fatal("invalid provider part index was emitted")
		}
	}
	if s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response","item_id":"item","delta":null}`)) != nil {
		t.Fatal("null transcript was accepted")
	}
	if s.API(apiEvent(`{"type":"response.output_audio_transcript.delta","response_id":"response","item_id":"item","delta":"visible"}`)) == nil {
		t.Fatal("valid provider text was discarded")
	}
	if s.API(apiEvent(`{"type":"conversation.item.deleted","item_id":"foreign"}`)) != nil {
		t.Fatal("foreign deletion cleared caption")
	}
	if value := s.API(apiEvent(`{"type":"conversation.item.truncated","item_id":"item"}`)); value == nil || value.Text != "" {
		t.Fatal("truncated current item retained text")
	}
	s.API(apiEvent(`{"type":"response.created","response":{"id":"final-response"}}`))
	if value := s.API(apiEvent(`{"type":"response.audio_transcript.done","response_id":"final-response","item_id":"final-item","transcript":"final transcript"}`)); value == nil || !value.Final || value.Text != "final transcript" {
		t.Fatal("final transcript did not replace its partial utterance")
	}
	if s.API(apiEvent(`{"type":"response.audio_transcript.delta","response_id":"final-response","item_id":"final-item","delta":"late"}`)) != nil {
		t.Fatal("late provider delta changed final caption")
	}
	if value := s.Clear(); value == nil || value.Text != "" {
		t.Fatal("explicit caption clear retained speech")
	}
	s.API(apiEvent(`{"type":"response.created","response":{"id":"next"}}`))
	s.API(apiEvent(`{"type":"response.audio_transcript.delta","response_id":"next","item_id":"item","delta":"partial"}`))
	if s.API(apiEvent(`{"type":"response.done","response":{"id":"foreign","status":"completed"}}`)) != nil {
		t.Fatal("foreign terminal response changed caption")
	}
	if value := s.API(apiEvent(`{"type":"response.done","response":{"id":"next","status":"cancelled"}}`)); value == nil || value.Text != "" {
		t.Fatal("failed response retained partial speech")
	}
	native := NewSubtitles("call", "subscription", nil)
	if native.Native("unrelated", nil) != nil || native.Native("thread/realtime/transcript/done", object(map[string]any{"role": "assistant", "text": false})) != nil {
		t.Fatal("invalid native transcript was emitted")
	}
	native.Native("thread/realtime/transcript/done", object(map[string]any{"role": "assistant", "text": "completed"}))
	if value := native.Native("thread/realtime/transcript/delta", object(map[string]any{"role": "assistant", "delta": "next utterance"})); value == nil || value.Text != "next utterance" {
		t.Fatal("new utterance appended a prior completed transcript")
	}
}
