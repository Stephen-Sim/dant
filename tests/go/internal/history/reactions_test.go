package history

import (
	"strings"
	"testing"
)

func TestReactionVocabularyRetainsRGISequencesWithoutBroadeningToComponents(t *testing.T) {
	for _, value := range []string{"👍", "❤️", "😂", "👀", "🎉", "👍🏽", "🧑🏾‍🚀", "👨‍👩‍👧‍👦", "🇲🇾", "1️⃣", "🏴\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f"} {
		if !IsReaction(value) {
			t.Fatal("supported emoji sequence lost")
		}
	}
	for _, value := range []string{"", "a", "👍👍", "🏽", "🇲", "👍 ", "\n👍", "👍\x00", "\ufe0f", strings.Repeat("😀", 40)} {
		if IsReaction(value) {
			t.Fatal("non-reaction accepted")
		}
	}
	if len(reactionSet()) != 3944 {
		t.Fatal("pinned Unicode vocabulary changed without regeneration")
	}
}
