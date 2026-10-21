package memory

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Text retains JavaScript UTF-16 slices, including a boundary that cuts a
// surrogate pair. Converting those slices to a Go string would lose text units.
type Text struct{ units []uint16 }

// UnmarshalJSON retains escaped legacy UTF-16 text without turning a lone
// surrogate into a different authored character.
func (t *Text) UnmarshalJSON(data []byte) error {
	if !json.Valid(data) || !utf8.Valid(data) || len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return ErrInvalidMemory
	}
	result := []uint16{}
	for cursor := 1; cursor < len(data)-1; {
		if data[cursor] != '\\' {
			r, width := utf8.DecodeRune(data[cursor:])
			result = append(result, utf16.Encode([]rune{r})...)
			cursor += width
			continue
		}
		cursor++
		escape := data[cursor]
		cursor++
		switch escape {
		case 'u':
			value, err := strconv.ParseUint(string(data[cursor:cursor+4]), 16, 16)
			if err != nil {
				return ErrInvalidMemory
			}
			result = append(result, uint16(value))
			cursor += 4
		case '"', '\\', '/':
			result = append(result, uint16(escape))
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
		default:
			return ErrInvalidMemory
		}
	}
	t.units = result
	return nil
}

func (t Text) UTF16Length() int { return len(t.units) }

func (t Text) MarshalJSON() ([]byte, error) {
	result := []byte{'"'}
	for index := 0; index < len(t.units); index++ {
		unit := t.units[index]
		switch {
		case unit == '"' || unit == '\\':
			result = append(result, '\\', byte(unit))
		case unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff && !(unit <= 0xdbff && index+1 < len(t.units) && t.units[index+1] >= 0xdc00 && t.units[index+1] <= 0xdfff)):
			hex := strconv.FormatUint(uint64(unit), 16)
			result = append(result, '\\', 'u')
			result = append(result, strings.Repeat("0", 4-len(hex))...)
			result = append(result, hex...)
		case unit >= 0xd800 && unit <= 0xdbff:
			result = utf8.AppendRune(result, utf16.DecodeRune(rune(unit), rune(t.units[index+1])))
			index++
		default:
			result = utf8.AppendRune(result, rune(unit))
		}
	}
	return append(result, '"'), nil
}

func units(value string) []uint16 { return utf16.Encode([]rune(value)) }

func unitLength(value string) int {
	count := 0
	for _, character := range value {
		count++
		if character > 0xffff {
			count++
		}
	}
	return count
}

func unitSlice(value []uint16, start, end int) []uint16 {
	start = min(max(0, start), len(value))
	end = min(max(start, end), len(value))
	return value[start:end]
}

func containsUnits(text, term []uint16) bool {
	for index := 0; index+len(term) <= len(text); index++ {
		match := true
		for offset, value := range term {
			if text[index+offset] != value {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func relevantExcerpt(text, normalized string, terms []string, maximum int) (Text, bool) {
	return relevantExcerptUnits(units(text), normalized, terms, maximum)
}

func relevantExcerptUnits(content []uint16, normalized string, terms []string, maximum int) (Text, bool) {
	positions := make([]int, 0, len(terms))
	for _, term := range terms {
		if position := strings.Index(normalized, term); position >= 0 {
			positions = append(positions, unitLength(normalized[:position]))
		}
	}
	if len(positions) == 0 {
		return Text{}, false
	}
	normalizedUnits := units(normalized)
	termUnits := make([][]uint16, len(terms))
	for index, term := range terms {
		termUnits[index] = units(term)
	}
	score := func(offset int) int {
		window, count := unitSlice(normalizedUnits, offset, offset+maximum), 0
		for _, term := range termUnits {
			if containsUnits(window, term) {
				count++
			}
		}
		return count
	}
	start := max(0, positions[0]-excerptLeadUnits)
	for _, position := range positions[1:] {
		candidate := max(0, position-excerptLeadUnits)
		if score(candidate) > score(start) {
			start = candidate
		}
	}
	if maximum <= 2 {
		clipped := unitSlice(content, start, start+maximum)
		return Text{units: clipped}, len(clipped) > 0
	}
	result, leading := make([]uint16, 0, maximum), 0
	if start > 0 {
		result = append(result, '…')
		leading = 1
	}
	end := min(len(content), start+max(0, maximum-leading))
	trailing := 0
	if end < len(content) {
		trailing = 1
	}
	result = append(result, unitSlice(content, start, max(start, end-trailing))...)
	if trailing != 0 {
		result = append(result, '…')
	}
	return Text{units: result}, len(result) > 0
}
