package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

var ErrJSONText = errors.New("invalid_json_text")

// DecodeJSONTextUnits preserves JavaScript string code units, including lone
// surrogates produced by historical String.slice. Identity validation remains
// separate: accepting user text here never authorizes an identity or action.
func DecodeJSONTextUnits(raw json.RawMessage) ([]uint16, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' || !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, ErrJSONText
	}

	result := make([]uint16, 0, len(raw))
	for index := 1; index < len(raw)-1; {
		if raw[index] != '\\' {
			character, size := utf8.DecodeRune(raw[index:])
			result = append(result, utf16.Encode([]rune{character})...)
			index += size
			continue
		}

		index++
		character := raw[index]
		index++
		switch character {
		case '"', '\\', '/':
			result = append(result, uint16(character))
		case 'b':
			result = append(result, '\b')
		case 'f':
			result = append(result, '\f')
		case 'n':
			result = append(result, '\n')
		case 'r':
			result = append(result, '\r')
		case 't':
			result = append(result, '\t')
		case 'u':
			number, err := strconv.ParseUint(string(raw[index:index+4]), 16, 16)
			if err != nil {
				return nil, ErrJSONText
			}
			result = append(result, uint16(number))
			index += 4
		default:
			return nil, ErrJSONText
		}
	}
	return result, nil
}

// EncodeJSONTextUnits emits the string spelling used by JSON.stringify. This
// matters for persisted legacy text and hashes: Go's default HTML/U+2028 escapes
// and replacement of lone surrogates would change the canonical code units.
func EncodeJSONTextUnits(units []uint16) json.RawMessage {
	var result strings.Builder
	result.WriteByte('"')
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch unit {
		case '"', '\\':
			result.WriteByte('\\')
			result.WriteByte(byte(unit))
		case '\b':
			result.WriteString(`\b`)
		case '\f':
			result.WriteString(`\f`)
		case '\n':
			result.WriteString(`\n`)
		case '\r':
			result.WriteString(`\r`)
		case '\t':
			result.WriteString(`\t`)
		default:
			if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
				result.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
				index++
			} else if unit < 0x20 || unit >= 0xd800 && unit <= 0xdfff {
				const digits = "0123456789abcdef"
				result.WriteString(`\u`)
				result.WriteByte(digits[unit>>12])
				result.WriteByte(digits[unit>>8&15])
				result.WriteByte(digits[unit>>4&15])
				result.WriteByte(digits[unit&15])
			} else {
				result.WriteRune(rune(unit))
			}
		}
	}
	result.WriteByte('"')
	return json.RawMessage(result.String())
}

func SliceJSONText(raw json.RawMessage, limit int) (json.RawMessage, error) {
	if limit < 0 {
		return nil, ErrJSONText
	}
	units, err := DecodeJSONTextUnits(raw)
	if err != nil {
		return nil, err
	}
	if len(units) > limit {
		units = units[:limit]
	}
	return EncodeJSONTextUnits(units), nil
}
