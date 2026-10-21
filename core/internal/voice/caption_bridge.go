package voice

import (
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/voice/captions"
)

type Caption = captions.Caption
type CaptionState = captions.CaptionState
type Subtitles = captions.Subtitles
type Redactor = captions.Redactor

const CaptionEventMethod = captions.CaptionEventMethod
const CaptionTextLimit = captions.CaptionTextLimit

func NewCaptionState(redact Redactor) *CaptionState { return captions.NewCaptionState(redact) }
func NewSubtitles(callID, provider string, redact Redactor) *Subtitles {
	return captions.NewSubtitles(callID, provider, redact)
}

func ReadCaption(raw json.RawMessage) *Caption { return captions.ReadCaption(raw) }
func captionID(value string) bool              { return captions.ValidID(value) }
