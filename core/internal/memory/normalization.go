package memory

import (
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

func normalizeText(text string) string {
	return cases.Lower(language.Und).String(norm.NFKC.String(text))
}

func jsSpace(value rune) bool {
	return value == '\t' || value == '\n' || value == '\v' || value == '\f' || value == '\r' || value == ' ' || value == 0xa0 || value == 0x1680 || value >= 0x2000 && value <= 0x200a || value == 0x2028 || value == 0x2029 || value == 0x202f || value == 0x205f || value == 0x3000 || value == 0xfeff
}

func trimText(text string) string { return strings.TrimFunc(text, jsSpace) }
func normalizeKey(text string) string {
	return strings.Join(strings.FieldsFunc(normalizeText(text), jsSpace), " ")
}

func searchTokens(text string) []string {
	return strings.FieldsFunc(normalizeText(text), func(value rune) bool {
		return !unicode.IsLetter(value) && !unicode.IsNumber(value) && value != '_' && value != '-'
	})
}

func cjkPairs(token string) []string {
	characters := []rune(token)
	for _, value := range characters {
		if !unicode.In(value, unicode.Han, unicode.Hiragana, unicode.Katakana) {
			return []string{token}
		}
	}
	if len(characters) < 2 {
		return []string{token}
	}
	result := make([]string, 0, len(characters)-1)
	for index := 1; index < len(characters); index++ {
		result = append(result, string(characters[index-1:index+1]))
	}
	return result
}

func indexedText(text string) string {
	expanded := []string{}
	for _, token := range searchTokens(text) {
		expanded = append(expanded, cjkPairs(token)...)
	}
	return text + "\n" + strings.Join(expanded, " ")
}

func safeQuery(text string) string {
	safe := SanitizeText(text)
	for _, value := range []string{"[sensitive value omitted]", "[API key omitted]", "[token omitted]", "[private key omitted]"} {
		safe = strings.ReplaceAll(safe, value, " ")
	}
	return safe
}

func PrepareSearch(query string) (PreparedQuery, error) {
	if unitLength(query) > MaxQueryUnits || strings.ContainsRune(query, 0) {
		return PreparedQuery{}, ErrInvalidQuery
	}
	return preparedTokens(searchTokens(safeQuery(query)), false), nil
}

func PrepareRetrieval(query string) (PreparedQuery, error) {
	text := Text{units: unitSlice(units(query), 0, 32*1024)}
	textString := stringFromUnits(text.units)
	textString = strings.ReplaceAll(norm.NFKC.String(safeQuery(textString)), "\x00", " ")
	var separated strings.Builder
	previous := false
	for _, character := range textString {
		current := unicode.In(character, unicode.Han, unicode.Hiragana, unicode.Katakana)
		if current != previous {
			separated.WriteByte(' ')
		}
		separated.WriteRune(character)
		previous = current
	}
	return preparedTokens(searchTokens(separated.String()), true), nil
}

func stringFromUnits(value []uint16) string {
	var out strings.Builder
	for index := 0; index < len(value); index++ {
		unit := value[index]
		if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(value) && value[index+1] >= 0xdc00 && value[index+1] <= 0xdfff {
			out.WriteRune(0x10000 + (rune(unit)-0xd800)*1024 + rune(value[index+1]) - 0xdc00)
			index++
		} else if unit >= 0xd800 && unit <= 0xdfff {
			out.WriteRune('\ufffd')
		} else {
			out.WriteRune(rune(unit))
		}
	}
	return out.String()
}

var retrievalStopWords = func() map[string]bool {
	result := map[string]bool{}
	for _, word := range strings.Fields("a an and are as at be been but by can could did do does for from have how i if in is it its let me my of on or our please recall remember remind should so some tell than that the their them then there these they this those to us use was we were what when where which who why will with would you your 请问 请你 帮我 我们 之前 继续 一下 什么 怎么 如何 这个 那个 现在 已经 需要 可以 请帮 能否") {
		result[word] = true
	}
	return result
}()

func preparedTokens(tokens []string, retrieval bool) PreparedQuery {
	seen := map[string]bool{}
	result := PreparedQuery{Terms: []string{}}
	length := 0
	for _, token := range tokens {
		for _, term := range cjkPairs(token) {
			if seen[term] {
				continue
			}
			seen[term] = true
			if retrieval && (retrievalStopWords[term] || length+unitLength(term) > MaxQueryUnits) {
				continue
			}
			result.Terms = append(result.Terms, term)
			length += unitLength(term)
			if len(result.Terms) == MaxTerms {
				return result
			}
		}
	}
	return result
}
