package contracts

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
)

// messagePresence retains representation metadata, not a second message model.
// Only omitted/null fields need a typed zero snapshot. Present values always
// come from the current checked DTO, including after a nonzero value is cleared.
type messagePresence struct {
	fields       map[string]messageFieldPresence
	textRequired bool
}

type messageFieldPresence struct {
	present bool
	null    bool
	initial json.RawMessage
}

func presenceFieldName(field reflect.StructField) string {
	name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
	if name == "-" || strings.Contains(options, "omitzero") {
		// Optional already retains omission, null and zero through its typed
		// Present/Null flags; never override its validated state transitions.
		return ""
	}
	return name
}

func rememberMessagePresence(value any, original RawObject) (messagePresence, error) {
	object := reflect.ValueOf(value)
	typ := object.Type()
	result := messagePresence{fields: make(map[string]messageFieldPresence)}
	for index := range typ.NumField() {
		name := presenceFieldName(typ.Field(index))
		if name == "" {
			continue
		}
		raw, present := original[name]
		field := messageFieldPresence{
			present: present,
			null:    present && bytes.Equal(bytes.TrimSpace(raw), []byte("null")),
		}
		if !present || field.null {
			initial, err := json.Marshal(object.Field(index).Interface())
			if err != nil {
				return messagePresence{}, err
			}
			field.initial = initial
		}
		result.fields[name] = field
	}
	return result, nil
}

func marshalMessagePresence(value any, extra RawObject, presence messagePresence) ([]byte, error) {
	raw, err := marshalExtended(value, extra)
	if err != nil || len(presence.fields) == 0 {
		return raw, err
	}
	var fields RawObject
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	object := reflect.ValueOf(value)
	typ := object.Type()
	for index := range typ.NumField() {
		name := presenceFieldName(typ.Field(index))
		previous, tracked := presence.fields[name]
		if !tracked || name == "text" && presence.textRequired {
			continue
		}
		current, err := json.Marshal(object.Field(index).Interface())
		if err != nil {
			return nil, err
		}
		switch {
		case !previous.present && bytes.Equal(current, previous.initial):
			delete(fields, name)
		case previous.null && bytes.Equal(current, previous.initial):
			fields[name] = json.RawMessage("null")
		default:
			if _, exists := fields[name]; !exists {
				fields[name] = current
			}
		}
	}
	return json.Marshal(fields)
}

// RetainLegacyPresence captures original field representation after the store's
// tolerant typed decoding, without restoring raw invalid enums or field values.
func (value *ChatMessage) RetainLegacyPresence(original RawObject) error {
	type wire ChatMessage
	presence, err := rememberMessagePresence(wire(*value), original)
	if err == nil {
		value.presence = presence
	}
	return err
}

// EnsurePublicText materializes the browser's required text string on a copied
// API projection. It does not change the original message's storage metadata.
func (value *ChatMessage) EnsurePublicText() {
	value.presence.textRequired = true
}
