package contracts

import "strings"

// TrimText retains ECMAScript String.trim semantics for existing wire fields.
// Unicode White_Space differs at U+0085 and U+FEFF, so strings.TrimSpace cannot
// substitute without changing a stored value or accepted token.
func TrimText(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return (character >= 0x0009 && character <= 0x000d) || character == 0x0020 || character == 0x00a0 || character == 0x1680 || (character >= 0x2000 && character <= 0x200a) || character == 0x2028 || character == 0x2029 || character == 0x202f || character == 0x205f || character == 0x3000 || character == 0xfeff
	})
}

func UTF16Length(value string) int {
	count := 0
	for _, character := range value {
		if character > 0xffff {
			count += 2
		} else {
			count++
		}
	}
	return count
}
