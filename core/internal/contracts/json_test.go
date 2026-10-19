package contracts

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDecodeObjectRetainsRawExtensionsAndRejectsAmbiguousObjects(t *testing.T) {
	object, err := DecodeObject([]byte(`{"legacy":{"value":9007199254740991},"text":"\ud800"}`), 1024)
	if err != nil || string(object["legacy"]) != `{"value":9007199254740991}` || string(object["text"]) != `"\ud800"` {
		t.Fatalf("raw legacy values changed: %v", err)
	}
	for _, raw := range []string{`null`, `[]`, `{"a":1,"\u0061":2}`, `{"nested":{"x":1,"x":2}}`, `{} {}`, `{"missing":}`, `{"x":"` + string([]byte{0xff}) + `"}`} {
		if _, err := DecodeObject([]byte(raw), 1024); !errors.Is(err, ErrInvalidJSON) {
			t.Errorf("ambiguous or invalid JSON accepted")
		}
	}
	if _, err := DecodeObject([]byte(`{"bounded":true}`), 3); !errors.Is(err, ErrInvalidJSON) {
		t.Fatal("object allocation bound ignored")
	}
	if !json.Valid(object["text"]) {
		t.Fatal("original JSON token lost")
	}
}

func TestIdentityUnicodeValidationNeverSubstitutesAnIdentifier(t *testing.T) {
	for _, raw := range []string{`"\ud800"`, `"\udfff"`, `"\ud800x"`, `"\ud800\u0061"`} {
		if ValidUnicodeJSON([]byte(raw)) {
			t.Fatal("identity with an unpaired surrogate accepted")
		}
	}
	for _, raw := range []string{`"work-id"`, `"\ud83d\ude00"`, `"\\ud800"`, `"标识"`} {
		if !ValidUnicodeJSON([]byte(raw)) {
			t.Fatal("valid identity token rejected")
		}
	}
}
