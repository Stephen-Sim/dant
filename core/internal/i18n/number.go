package i18n

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
)

// Fixed locale rules keep integer grouping and Unicode separators consistent
// across system locale and CLDR updates.
//
//go:embed number-formats.json
var numberFormatJSON []byte

type numberFormat struct {
	Separator                   string
	Primary, Secondary, Minimum int
}

var numberOnce sync.Once
var numberFormats map[string]numberFormat

func formatCount(code string, count int64) string {
	numberOnce.Do(func() { _ = json.Unmarshal(numberFormatJSON, &numberFormats) })
	text := strconv.FormatInt(count, 10)
	format := numberFormats[code]
	if len(text) < format.Minimum || format.Primary < 1 || format.Secondary < 1 {
		return text
	}
	parts := []string{}
	width := format.Primary
	for len(text) > width {
		parts = append(parts, text[len(text)-width:])
		text = text[:len(text)-width]
		width = format.Secondary
	}
	parts = append(parts, text)
	for a, b := 0, len(parts)-1; a < b; a, b = a+1, b-1 {
		parts[a], parts[b] = parts[b], parts[a]
	}
	return strings.Join(parts, format.Separator)
}
