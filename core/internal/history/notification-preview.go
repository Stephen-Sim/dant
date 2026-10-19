package history

import (
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"regexp"
	"strings"
	"unicode"
)

var notificationFences = regexp.MustCompile("```[^\\n]*\\n?")
var notificationLinks = regexp.MustCompile(`!?\[([^\]]*)\]\([^\n)]*\)`)
var notificationTags = regexp.MustCompile(`<[^>]*>`)
var notificationLists = regexp.MustCompile(`(?m)^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)`)
var notificationStars = regexp.MustCompile(`\*([^*\n]+)\*`)
var notificationDouble = regexp.MustCompile(`(\*\*|__|~~)`)
var notificationEntities = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&apos;", "'", "&#39;", "'")

func plainNotificationText(value string) string {
	// Bounded before regex work; user Markdown is display text, never HTML.
	units := []rune(value)
	if len(units) > 8192 {
		value = string(units[:8192])
	}
	value = notificationFences.ReplaceAllString(value, "")
	value = notificationLinks.ReplaceAllString(value, "$1")
	value = notificationTags.ReplaceAllString(value, "")
	value = notificationEntities.Replace(value)
	value = notificationLists.ReplaceAllString(value, "")
	value = notificationDouble.ReplaceAllString(value, "")
	value = notificationStars.ReplaceAllString(value, "$1")
	value = strings.ReplaceAll(value, "`", "")
	value = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || character >= 0x200b && character <= 0x200f || character >= 0x202a && character <= 0x202e || character >= 0x2060 && character <= 0x206f || character == 0xfeff {
			return ' '
		}
		return character
	}, value)
	return contracts.TrimText(strings.Join(strings.Fields(value), " "))
}

func boundedPreview(value string) string {
	characters := []rune(plainNotificationText(value))
	if len(characters) > NotificationPreviewLength {
		return string(characters[:NotificationPreviewLength-1]) + "…"
	}
	return string(characters)
}
