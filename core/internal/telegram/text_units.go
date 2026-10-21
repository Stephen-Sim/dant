package telegram

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// Replacement offsets are measured in decoded UTF-16 units. A legacy lone
// surrogate occupies one unit and therefore remains intact outside a match.
func replaceTextUnits(units []uint16, pattern *regexp.Regexp, replacement func([]uint16, string, []int) []uint16) []uint16 {
	decoded := string(utf16.Decode(units))
	result := []uint16{}
	through := 0
	for _, match := range pattern.FindAllStringSubmatchIndex(decoded, -1) {
		begin, end := contracts.UTF16Length(decoded[:match[0]]), contracts.UTF16Length(decoded[:match[1]])
		result = append(result, units[through:begin]...)
		result = append(result, replacement(units, decoded, match)...)
		through = end
	}
	return append(result, units[through:]...)
}

func mirrorUnits(rawText json.RawMessage, desktop, token string) ([]uint16, error) {
	units, err := contracts.DecodeJSONTextUnits(rawText)
	if err != nil {
		return nil, ErrIncoming
	}
	if desktop != "" {
		units = append(utf16.Encode([]rune(desktop+":\n")), units...)
	} else {
		units = replaceTextUnits(units, markdownLink, func(original []uint16, text string, match []int) []uint16 {
			target := strings.TrimSuffix(strings.TrimPrefix(text[match[4]:match[5]], "<"), ">")
			if decoded, err := url.PathUnescape(target); err == nil {
				target = decoded
			}
			begin, end := match[0], match[1]
			if localTarget.MatchString(target) {
				begin, end = match[2], match[3]
			}
			return original[contracts.UTF16Length(text[:begin]):contracts.UTF16Length(text[:end])]
		})
	}
	if token != "" {
		units = replaceTextUnits(units, regexp.MustCompile(regexp.QuoteMeta(token)), func([]uint16, string, []int) []uint16 { return utf16.Encode([]rune("[redacted]")) })
	}
	return units, nil
}

func splitUnits(units []uint16) [][]uint16 {
	parts := [][]uint16{}
	for len(units) > 0 {
		end := min(MaxTextUnits, len(units))
		if end < len(units) && units[end-1] >= 0xd800 && units[end-1] <= 0xdbff {
			end--
		}
		parts = append(parts, append([]uint16{}, units[:end]...))
		units = units[end:]
	}
	return parts
}
