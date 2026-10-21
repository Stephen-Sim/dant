package captions

import (
	"encoding/json"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const CaptionEventMethod = "dant/call/subtitle"
const CaptionTextLimit = 4000
const captionRawLimit = 65536
const captionRetiredLimit = 64

type Caption struct {
	CallID   string `json:"callId"`
	Provider string `json:"provider"`
	Sequence int64  `json:"sequence"`
	Text     string `json:"text"`
	Final    bool   `json:"final"`
}
type Redactor func(string) string

func captionID(id string) bool {
	if id == "" || contracts.UTF16Length(id) > 256 {
		return false
	}
	for _, c := range id {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

func ValidID(value string) bool                 { return captionID(value) }
func ValidText(value string) bool               { return captionText(value) }
func TailText(value string, maximum int) string { return tailText(value, maximum) }
func captionProvider(provider string) bool      { return provider == "api" || provider == "subscription" }
func captionText(text string) bool {
	return contracts.UTF16Length(text) <= CaptionTextLimit && !strings.ContainsFunc(text, func(c rune) bool { return c <= 8 || c == 11 || c == 12 || c >= 14 && c <= 31 || c == 127 })
}
func ReadCaption(raw json.RawMessage) *Caption {
	object, err := contracts.DecodeObject(raw, 32*1024)
	if err != nil {
		return nil
	}
	for _, key := range []string{"callId", "provider", "sequence", "text", "final"} {
		if value, ok := object[key]; !ok || string(value) == "null" {
			return nil
		}
	}
	var value Caption
	if json.Unmarshal(raw, &value) != nil || !captionID(value.CallID) || !captionProvider(value.Provider) || value.Sequence < 1 || value.Sequence > 9007199254740991 || !captionText(value.Text) {
		return nil
	}
	return &value
}
func safeCaption(text string, redact Redactor) (result string) {
	defer func() {
		if recover() != nil {
			result = ""
		}
	}()
	if redact != nil {
		text = redact(text)
	}
	text = strings.Map(func(c rune) rune {
		if c <= 8 || c == 11 || c == 12 || c >= 14 && c <= 31 || c == 127 {
			return -1
		}
		return c
	}, text)
	return tailText(text, CaptionTextLimit)
}
func tailText(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) > limit {
		units = units[len(units)-limit:]
		if len(units) > 0 && units[0] >= 0xdc00 && units[0] <= 0xdfff {
			units = units[1:]
		}
	}
	return string(utf16.Decode(units))
}

type retiredIDs struct {
	order []string
	set   map[string]bool
}

func (r *retiredIDs) has(id string) bool { return r.set[id] }
func (r *retiredIDs) add(id string) {
	if id == "" || r.has(id) {
		return
	}
	if r.set == nil {
		r.set = map[string]bool{}
	}
	r.set[id] = true
	r.order = append(r.order, id)
	for len(r.order) > captionRetiredLimit {
		delete(r.set, r.order[0])
		r.order = r.order[1:]
	}
}
func (r *retiredIDs) clear() {
	r.order = nil
	r.set = nil
}

// CaptionState is RAM-only. Neither Store persistence nor cached Controller
// observations own this transient text; scope changes retire the old owner.
type CaptionState struct {
	mu                      sync.Mutex
	redact                  Redactor
	callID, provider, scope string
	sequence                int64
	connected               bool
	caption                 *Caption
	retired                 retiredIDs
}

func NewCaptionState(redact Redactor) *CaptionState { return &CaptionState{redact: redact} }
func (s *CaptionState) end() {
	if s.callID != "" {
		s.retired.add(s.callID + "\x00" + s.provider)
	}
	s.callID = ""
	s.provider = ""
	s.sequence = 0
	s.connected = false
	s.caption = nil
}
func (s *CaptionState) End() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.end()
}
func (s *CaptionState) Sync(call *contracts.Call, scope string, connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if scope != s.scope {
		s.end()
		s.retired.clear()
		s.scope = scope
	}
	if call == nil || !captionID(call.ID) || !captionProvider(call.Provider) || (call.Status != "connecting" && call.Status != "negotiating" && call.Status != "connected") || s.retired.has(call.ID+"\x00"+call.Provider) {
		s.end()
		return
	}
	if s.callID != call.ID || s.provider != call.Provider {
		s.end()
		s.callID = call.ID
		s.provider = call.Provider
	}
	s.connected = connected
	if !connected {
		s.caption = nil
	}
}
func (s *CaptionState) Observe(value Caption) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !captionID(value.CallID) || !captionProvider(value.Provider) || !captionText(value.Text) || value.Sequence <= s.sequence || value.Sequence > 9007199254740991 || !s.connected || value.CallID != s.callID || value.Provider != s.provider {
		return false
	}
	value.Text = safeCaption(value.Text, s.redact)
	s.sequence = value.Sequence
	s.caption = &value
	return true
}
func (s *CaptionState) Receive(method string, params json.RawMessage) bool {
	if method != CaptionEventMethod {
		return false
	}
	value := ReadCaption(params)
	return value != nil && s.Observe(*value)
}
func (s *CaptionState) Snapshot() *Caption {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.caption == nil {
		return nil
	}
	value := *s.caption
	return &value
}

// Subtitles owns one assistant utterance and its provider event ordering. It
// never reads or writes chat/history and never fabricates user captions.
type Subtitles struct {
	mu                  sync.Mutex
	callID, provider    string
	redact              Redactor
	raw, text           string
	final               bool
	sequence            int64
	responseID, itemKey string
	partOrder           int
	retired             retiredIDs
}

func NewSubtitles(callID, provider string, redact Redactor) *Subtitles {
	return &Subtitles{callID: callID, provider: provider, redact: redact, partOrder: -1}
}
func (s *Subtitles) publish(text string, final bool) *Caption {
	safe := safeCaption(text, s.redact)
	if s.text == safe && s.final == final {
		return nil
	}
	s.text = safe
	s.final = final
	s.sequence++
	return &Caption{s.callID, s.provider, s.sequence, s.text, s.final}
}
func (s *Subtitles) clear() *Caption {
	s.raw = ""
	s.itemKey = ""
	s.partOrder = -1
	return s.publish("", false)
}
func (s *Subtitles) Clear() *Caption {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clear()
}
func (s *Subtitles) Snapshot() Caption {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Caption{s.callID, s.provider, s.sequence, s.text, s.final}
}
func (s *Subtitles) write(value json.RawMessage, done, appendValue bool) *Caption {
	var text string
	if string(value) == "null" || json.Unmarshal(value, &text) != nil {
		return nil
	}
	if s.final && appendValue {
		s.raw = ""
	}
	if appendValue {
		text = s.raw + text
	}
	s.raw = tailText(text, captionRawLimit)
	return s.publish(s.raw, done)
}
func (s *Subtitles) Native(method string, p contracts.RawObject) *Caption {
	s.mu.Lock()
	defer s.mu.Unlock()
	if method != "thread/realtime/transcript/delta" && method != "thread/realtime/transcript/done" {
		return nil
	}
	if textField(p, "role") == "user" {
		return s.clear()
	}
	if textField(p, "role") != "assistant" {
		return nil
	}
	if strings.HasSuffix(method, "/delta") {
		return s.write(p["delta"], false, true)
	}
	return s.write(p["text"], true, false)
}
func (s *Subtitles) API(event contracts.RawObject) *Caption {
	s.mu.Lock()
	defer s.mu.Unlock()
	kind := textField(event, "type")
	response := objectField(event, "response")
	switch kind {
	case "response.created":
		id := textField(response, "id")
		if !captionID(id) || string(response["conversation_id"]) == "null" || s.retired.has(id) || id == s.responseID {
			return nil
		}
		s.retired.add(s.responseID)
		s.responseID = id
		return s.clear()
	case "input_audio_buffer.speech_started":
		s.retired.add(s.responseID)
		s.responseID = ""
		return s.clear()
	case "conversation.item.deleted", "conversation.item.truncated":
		if s.itemKey != "" && strings.HasPrefix(s.itemKey, textField(event, "item_id")+":") {
			s.retired.add(s.responseID)
			s.responseID = ""
			return s.clear()
		}
		return nil
	case "response.done":
		if textField(response, "id") != s.responseID {
			return nil
		}
		var result *Caption
		if textField(response, "status") != "completed" {
			result = s.clear()
		} else if s.raw != "" {
			result = s.publish(s.raw, true)
		}
		s.retired.add(s.responseID)
		s.responseID = ""
		return result
	}
	delta := kind == "response.output_audio_transcript.delta" || kind == "response.audio_transcript.delta"
	done := kind == "response.output_audio_transcript.done" || kind == "response.audio_transcript.done"
	if (!delta && !done) || s.responseID == "" || textField(event, "response_id") != s.responseID || !captionID(textField(event, "item_id")) {
		return nil
	}
	output, ok := captionIndex(event, "output_index")
	if !ok {
		return nil
	}
	content, ok := captionIndex(event, "content_index")
	if !ok {
		return nil
	}
	order := output*129 + content
	key := textField(event, "item_id") + ":" + fmtInt(content)
	if order < s.partOrder || order == s.partOrder && s.itemKey != "" && key != s.itemKey {
		return nil
	}
	if key != s.itemKey {
		s.raw = ""
		s.final = false
		s.itemKey = key
		s.partOrder = order
	} else if s.final {
		return nil
	}
	if delta {
		return s.write(event["delta"], done, true)
	}
	return s.write(event["transcript"], done, false)
}
func captionIndex(object contracts.RawObject, key string) (int, bool) {
	value, exists := object[key]
	if !exists {
		return 0, true
	}
	var index int
	if string(value) == "null" || json.Unmarshal(value, &index) != nil || index < 0 || index > 128 {
		return 0, false
	}
	return index, true
}
