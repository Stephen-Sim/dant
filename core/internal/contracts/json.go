package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

// RawObject is used only at disk/transport boundaries and for retained legacy
// extension fields. Consumed fields are decoded into their owning typed DTO.
type RawObject map[string]json.RawMessage

const JSONMaxDepth = 128

var ErrInvalidJSON = errors.New("invalid_json")

// ValidUnicodeJSON is for consumed identities and transport control fields.
// Raw user text remains untouched so legacy UTF-16 fragments can round-trip.
func ValidUnicodeJSON(raw []byte) bool {
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return false
	}
	quoted := false
	for index := 0; index < len(raw); index++ {
		if raw[index] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return false
		}
		if raw[index] != 'u' {
			continue
		}
		if index+4 >= len(raw) {
			return false
		}
		value, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil {
			return false
		}
		index += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value >= 0xd800 && value <= 0xdbff {
			if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 6
		}
	}
	return !quoted
}

// DecodeObject rejects duplicate keys, invalid UTF-8 and trailing JSON values.
func DecodeObject(data []byte, maxBytes int) (RawObject, error) {
	if len(data) == 0 || len(data) > maxBytes || !utf8.Valid(data) {
		return nil, ErrInvalidJSON
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := validateJSONValue(decoder, 0); err != nil {
		return nil, ErrInvalidJSON
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidJSON
	}
	var object RawObject
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return nil, ErrInvalidJSON
	}
	return object, nil
}

func validateJSONValue(decoder *json.Decoder, depth int) error {
	if depth > JSONMaxDepth {
		return ErrInvalidJSON
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			key, err := decoder.Token()
			name, valid := key.(string)
			if err != nil || !valid {
				return ErrInvalidJSON
			}
			if _, duplicate := seen[name]; duplicate {
				return ErrInvalidJSON
			}
			seen[name] = struct{}{}
			if err := validateJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return ErrInvalidJSON
		}
	case '[':
		for decoder.More() {
			if err := validateJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return ErrInvalidJSON
		}
	default:
		return ErrInvalidJSON
	}
	return nil
}

// APIError contains deliberately public fixed text; internal causes never
// become an HTTP error body through Error().
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (err *APIError) Error() string { return err.Code }
