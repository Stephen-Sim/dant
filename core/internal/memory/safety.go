package memory

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const sensitiveOmitted = "[sensitive value omitted]"

var sensitiveAssignment = regexp.MustCompile(`(?i)(?:"(?:password|api[ _-]?key|access[ _-]?token|secret)"|'(?:password|api[ _-]?key|access[ _-]?token|secret)'|\b(?:password|api[ _-]?key|access[ _-]?token|secret))[ \t]*[:=][ \t]*`)
var privateKey = regexp.MustCompile(`(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----`)
var apiKey = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`)

const javascriptSpaceClass = `[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var bearer = regexp.MustCompile(`(?i)\bBearer` + javascriptSpaceClass + `+[A-Za-z0-9._~+/-]{16,}`)
var memoryDelimiter = regexp.MustCompile(`(?i)</?dant-memory\b`)
var yamlBlock = regexp.MustCompile(`^(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#[^\r\n]*)?)?\r?\n`)
var secretAssignment = regexp.MustCompile(`(?i)\b(?:password|api[ _-]?key|access[ _-]?token|secret)` + javascriptSpaceClass + `*[:=]` + javascriptSpaceClass + `*`)

func assignmentEnd(text string, start, keyStart int) int {
	if strings.HasPrefix(text[start:], sensitiveOmitted) {
		return start + len(sensitiveOmitted)
	}
	quoted := start
	for quoted < len(text) && strings.ContainsRune(" \t\r\n", rune(text[quoted])) {
		quoted++
	}
	for _, delimiter := range []string{"\"\"\"", "'''", "\"", "'", "`"} {
		if !strings.HasPrefix(text[quoted:], delimiter) {
			continue
		}
		for cursor := quoted + len(delimiter); cursor < len(text); cursor++ {
			if text[cursor] == '\\' {
				cursor++
				continue
			}
			if strings.HasPrefix(text[cursor:], delimiter) {
				return cursor + len(delimiter)
			}
		}
		return len(text)
	}
	value := text[start:]
	lineStart := strings.LastIndex(text[:keyStart], "\n") + 1
	prefix := text[lineStart:keyStart]
	block := yamlBlock.FindStringIndex(value)
	if block != nil && strings.Trim(prefix, " \t") == "" {
		cursor, end := start+block[1], start
		for cursor < len(text) {
			next := strings.IndexByte(text[cursor:], '\n')
			stop := len(text)
			if next >= 0 {
				stop = cursor + next
			}
			line := strings.TrimSuffix(text[cursor:stop], "\r")
			indent := len(line) - len(strings.TrimLeft(line, " \t"))
			if trimText(line) != "" && indent <= len(prefix) {
				break
			}
			end = stop
			if stop > cursor && text[stop-1] == '\r' {
				end--
			}
			cursor = stop + 1
		}
		if end > start {
			return end
		}
	}
	end := start
	for end < len(text) {
		value, width := utf8.DecodeRuneInString(text[end:])
		if jsSpace(value) {
			break
		}
		end += width
	}
	return end
}

// SanitizeText applies the same reference-only credential redaction as Node.
func SanitizeText(text string) string {
	var out strings.Builder
	cursor := 0
	for cursor < len(text) {
		match := sensitiveAssignment.FindStringIndex(text[cursor:])
		if match == nil {
			out.WriteString(text[cursor:])
			break
		}
		begin, end := cursor+match[0], cursor+match[1]
		stop := assignmentEnd(text, end, begin)
		out.WriteString(text[cursor:end])
		if stop > end {
			out.WriteString(sensitiveOmitted)
			cursor = stop
		} else {
			cursor = end
		}
	}
	safe := out.String()
	safe = privateKey.ReplaceAllString(safe, "[private key omitted]")
	safe = apiKey.ReplaceAllString(safe, "[API key omitted]")
	safe = bearer.ReplaceAllString(safe, "Bearer [token omitted]")
	return memoryDelimiter.ReplaceAllString(safe, "[memory delimiter]")
}

func ContainsSecret(text string) bool {
	if SanitizeText(text) != text {
		return true
	}
	for _, match := range secretAssignment.FindAllStringIndex(text, -1) {
		if match[1] < len(text) {
			value, _ := utf8.DecodeRuneInString(text[match[1]:])
			if !jsSpace(value) {
				return true
			}
		}
	}
	return false
}
