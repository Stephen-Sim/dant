package telegram

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

//go:embed assets/words.json
var wordsData []byte

var words = func() map[string]map[string]json.RawMessage {
	var result map[string]map[string]json.RawMessage
	if json.Unmarshal(wordsData, &result) != nil {
		panic("telegram_copy_invalid")
	}
	return result
}()

func (gateway *Gateway) word(key string) string {
	language := gateway.options.Store.Snapshot().Settings.Language
	var english, chinese string
	_ = json.Unmarshal(words["en"][key], &english)
	_ = json.Unmarshal(words["zh"][key], &chinese)
	return i18n.Translate(language, english, chinese)
}

func (gateway *Gateway) stateLabel(status string) string {
	var english, chinese map[string]string
	_ = json.Unmarshal(words["en"]["states"], &english)
	_ = json.Unmarshal(words["zh"]["states"], &chinese)
	if english[status] == "" {
		status = "unknown"
	}
	return i18n.Translate(gateway.options.Store.Snapshot().Settings.Language, english[status], chinese[status])
}

func clip(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	return string(utf16.Decode(units[:limit]))
}

func SplitText(text string) []string {
	units := utf16.Encode([]rune(text))
	result := []string{}
	for len(units) > 0 {
		end := min(MaxTextUnits, len(units))
		if end < len(units) && units[end-1] >= 0xd800 && units[end-1] <= 0xdbff {
			end--
		}
		result = append(result, string(utf16.Decode(units[:end])))
		units = units[end:]
	}
	return result
}

var markdownLink = regexp.MustCompile(`!?\[([^\]\n]*)\]\((<?[^)\n]+>?)\)`)
var localTarget = regexp.MustCompile(`(?i)^(?:file:|[a-z]:[/\\]|/(?:[^/]|$)|\.{1,2}[/\\]|output[/\\])`)

func MirrorText(text string) string {
	return markdownLink.ReplaceAllStringFunc(text, func(match string) string {
		parts := markdownLink.FindStringSubmatch(match)
		target := strings.TrimSuffix(strings.TrimPrefix(parts[2], "<"), ">")
		if decoded, err := url.PathUnescape(target); err == nil {
			target = decoded
		}
		if localTarget.MatchString(target) {
			return parts[1]
		}
		return match
	})
}

func (gateway *Gateway) publicText(text string) string {
	text = gateway.options.Redact(text)
	text = strings.Map(func(character rune) rune {
		if character < 32 || character == 127 {
			return ' '
		}
		return character
	}, text)
	return clip(contracts.TrimText(text), 240)
}
