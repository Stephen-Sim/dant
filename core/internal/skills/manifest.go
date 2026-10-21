package skills

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

var manifestField = regexp.MustCompile(`^([a-z][a-z-]*):(?:\s+(.*))?$`)
var quotedScalar = regexp.MustCompile(`^("(?:[^"\\]|\\.)*")(?:\s*#.*)?$`)
var singleScalar = regexp.MustCompile(`^'((?:[^']|'')*)'(?:\s*#.*)?$`)
var scalarReference = regexp.MustCompile(`\s[&*][\w-]+`)
var scalarComment = regexp.MustCompile(`\s+#.*$`)
var blockScalar = regexp.MustCompile(`^[|>][-+]?$`)

func scalar(value string) (string, error) {
	value = contracts.TrimText(value)
	if strings.HasPrefix(value, "\"") {
		match := quotedScalar.FindStringSubmatch(value)
		var result string
		if match == nil || json.Unmarshal([]byte(match[1]), &result) != nil || !contracts.ValidUnicodeJSON([]byte(match[1])) {
			return "", invalid()
		}
		return result, nil
	}
	if strings.HasPrefix(value, "'") {
		match := singleScalar.FindStringSubmatch(value)
		if match == nil {
			return "", invalid()
		}
		return strings.ReplaceAll(match[1], "''", "'"), nil
	}
	if value == "" || strings.ContainsRune("#!&*[{", rune(value[0])) || scalarReference.MatchString(value) {
		return "", invalid()
	}
	return contracts.TrimText(scalarComment.ReplaceAllString(value, "")), nil
}

func parseManifest(data []byte, source string) (SaveInput, error) {
	if !utf8.Valid(data) || nonText.Match(data) || binarySignature(data) {
		return SaveInput{}, invalid()
	}
	text := strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return SaveInput{}, invalid()
	}
	boundary := strings.Index(text[4:], "\n---\n")
	if boundary < 0 || boundary+4 > 8192 {
		return SaveInput{}, invalid()
	}
	boundary += 4
	lines := strings.Split(text[4:boundary], "\n")
	fields := map[string]string{}
	seen := map[string]bool{}
	for index := 0; index < len(lines); {
		line := lines[index]
		index++
		if contracts.TrimText(line) == "" || strings.HasPrefix(strings.TrimLeft(line, " \t"), "#") {
			continue
		}
		match := manifestField.FindStringSubmatch(line)
		if match == nil || seen[match[1]] {
			return SaveInput{}, invalid()
		}
		key, value := match[1], match[2]
		seen[key] = true
		switch key {
		case "name", "description", "license", "compatibility", "metadata":
		default:
			return SaveInput{}, invalid()
		}
		if key == "metadata" {
			for index < len(lines) && (strings.HasPrefix(lines[index], " ") || strings.HasPrefix(lines[index], "\t") || contracts.TrimText(lines[index]) == "") {
				index++
			}
			continue
		}
		if blockScalar.MatchString(contracts.TrimText(value)) {
			pieces := []string{}
			indent := -1
			for index < len(lines) && (strings.HasPrefix(lines[index], " ") || strings.HasPrefix(lines[index], "\t") || contracts.TrimText(lines[index]) == "") {
				item := lines[index]
				index++
				if contracts.TrimText(item) != "" {
					spaces := len(item) - len(strings.TrimLeft(item, " "))
					if spaces == 0 || strings.HasPrefix(item, "\t") {
						return SaveInput{}, invalid()
					}
					if indent < 0 || spaces < indent {
						indent = spaces
					}
				}
				pieces = append(pieces, item)
			}
			if indent < 0 {
				return SaveInput{}, invalid()
			}
			for index, item := range pieces {
				if contracts.TrimText(item) == "" {
					pieces[index] = ""
				} else {
					pieces[index] = item[indent:]
				}
			}
			if strings.HasPrefix(value, ">") {
				var joined strings.Builder
				for index, item := range pieces {
					if index > 0 {
						if pieces[index-1] != "" && item != "" {
							joined.WriteByte(' ')
						} else {
							joined.WriteByte('\n')
						}
					}
					joined.WriteString(item)
				}
				fields[key] = contracts.TrimText(joined.String())
			} else {
				fields[key] = contracts.TrimText(strings.Join(pieces, "\n"))
			}
		} else {
			parsed, err := scalar(value)
			if err != nil {
				return SaveInput{}, err
			}
			fields[key] = parsed
		}
	}
	result := SaveInput{Name: fields["name"], Description: contracts.TrimText(fields["description"]), Instructions: contracts.TrimText(text[boundary+5:])}
	if !namePattern.MatchString(result.Name) || result.Description == "" || len(result.Description) > DescriptionBytes || result.Instructions == "" {
		return SaveInput{}, invalid()
	}
	provenance := []string{}
	if strings.HasPrefix(source, "https://github.com/") {
		provenance = append(provenance, "Source: "+source)
	}
	for _, key := range []string{"license", "compatibility"} {
		if fields[key] != "" {
			provenance = append(provenance, strings.ToUpper(key[:1])+key[1:]+": "+fields[key])
		}
	}
	if len(provenance) > 0 {
		result.Instructions += "\n\n---\nImported skill reference metadata:\n" + strings.Join(provenance, "\n")
	}
	if len(result.Instructions) > InstructionBytes {
		return SaveInput{}, limited()
	}
	return result, nil
}
