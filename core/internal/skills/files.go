package skills

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func ValidFileName(value string) bool {
	if !utf8.ValidString(value) || contracts.UTF16Length(value) > RelativePathCharacters ||
		strings.ContainsAny(value, "\\\x00") || !supportPattern.MatchString(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, ":") || hasControl(part) {
			return false
		}
	}
	return true
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}

func binarySignature(data []byte) bool {
	value := string(data)
	for _, prefix := range []string{"%PDF-", "MZ", "PK\x03\x04", "RIFF", "OggS", "GIF87a", "GIF89a"} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

func textFile(data []byte) bool {
	return utf8.Valid(data) && !nonText.Match(data) && !binarySignature(data)
}

func decodeBinary(value BinaryFile) ([]byte, error) {
	if value.Encoding != "base64" || value.MediaType != "application/octet-stream" ||
		len(value.Data) > 4*((FileBytes+2)/3) || strings.ContainsAny(value.Data, "\r\n") {
		return nil, invalid()
	}
	data, err := base64.StdEncoding.Strict().DecodeString(value.Data)
	if err != nil || base64.StdEncoding.EncodeToString(data) != value.Data {
		return nil, invalid()
	}
	if len(data) > FileBytes {
		return nil, limited()
	}
	return data, nil
}

func (library *Library) secret(ctx context.Context, data []byte) bool {
	if library.containsSecret == nil {
		return false
	}
	// Invalid UTF-8 and BOM-marked UTF-16 are inspected without changing bytes.
	if library.containsSecret(ctx, strings.ToValidUTF8(string(data), "\ufffd")) {
		return true
	}
	if len(data) >= 2 && (data[0] == 255 && data[1] == 254 || data[0] == 254 && data[1] == 255) {
		units := make([]uint16, 0, (len(data)-2)/2)
		for offset := 2; offset+1 < len(data); offset += 2 {
			var value uint16
			if data[0] == 255 {
				value = binary.LittleEndian.Uint16(data[offset:])
			} else {
				value = binary.BigEndian.Uint16(data[offset:])
			}
			units = append(units, value)
		}
		return library.containsSecret(ctx, string(utf16.Decode(units)))
	}
	return false
}

func editable(snapshot Snapshot) (map[string]string, map[string]string) {
	selected, preserved := map[string]string{}, map[string]string{}
	total := len(snapshot.Instructions)
	encoded := len(jsonBytes(struct {
		Instructions string            `json:"instructions"`
		Files        map[string]string `json:"files"`
	}{snapshot.Instructions, map[string]string{}}))
	for _, name := range sortedNames(snapshot.Files) {
		value := snapshot.Files[name]
		entry := len(jsonBytes(name)) + 1 + len(jsonBytes(value))
		if len(selected) > 0 {
			entry++
		}
		if len(value) > EditorFileBytes || total+len(value) > EditorTotalBytes || encoded+entry > EditorJSONBytes {
			preserved[name] = value
			continue
		}
		selected[name] = value
		total += len(value)
		encoded += entry
	}
	return selected, preserved
}
