package memory

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func validID(value string) bool {
	if value == "" || !utf8.ValidString(value) || unitLength(value) > MaxIDUnits {
		return false
	}
	for _, character := range value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func prepare(query PreparedQuery, operator string, maximumUnits int) (string, error) {
	if len(query.Terms) > MaxTerms {
		return "", ErrInvalidQuery
	}
	seen, length := make(map[string]bool), 0
	quoted := make([]string, 0, len(query.Terms))
	for _, term := range query.Terms {
		if term == "" || !utf8.ValidString(term) || seen[term] {
			return "", ErrInvalidQuery
		}
		for _, character := range term {
			if !unicode.IsLetter(character) && !unicode.IsNumber(character) && character != '_' && character != '-' {
				return "", ErrInvalidQuery
			}
		}
		length += unitLength(term)
		if length > maximumUnits {
			return "", ErrInvalidQuery
		}
		seen[term] = true
		quoted = append(quoted, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, operator), nil
}
