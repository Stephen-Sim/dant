package memory

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestJSONTextPreservesUTF16AndEscapesWithoutReplacement(t *testing.T) {
	for _, test := range []struct {
		units []uint16
		json  string
	}{
		{[]uint16{}, `""`},
		{[]uint16{'"', '\\', '\n', 0}, `"\"\\\u000a\u0000"`},
		{[]uint16{0xd83d}, `"\ud83d"`},
		{[]uint16{0xde00}, `"\ude00"`},
		{[]uint16{0xd83d, 0xde00}, `"😀"`},
	} {
		encoded, err := (Text{units: test.units}).MarshalJSON()
		if err != nil || string(encoded) != test.json || !json.Valid(encoded) {
			t.Fatalf("UTF-16 JSON mismatch: %q %v", encoded, err)
		}
	}
}

func TestTinyBudgetCannotInventAnEmptyExcerpt(t *testing.T) {
	// NFKC can lengthen normalized text. Match positions intentionally use the
	// TypeScript normalized offset while slicing the original UTF-16 text.
	if text, matched := relevantExcerpt("x", strings.Repeat("a", 120)+"needle", []string{"needle"}, 1); matched || text.UTF16Length() != 0 {
		t.Fatal("an empty UTF-16 slice is not a reference")
	}
	for maximum := 1; maximum <= 2; maximum++ {
		text, matched := relevantExcerpt("needle text", "needle text", []string{"needle"}, maximum)
		if !matched || text.UTF16Length() != maximum {
			t.Fatal("tiny budgets must remain bounded")
		}
	}
}
