package contracts

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestJSONTextPreservesCanonicalEscapesAndUTF16(t *testing.T) {
	for _, fixture := range []struct{ input, canonical string }{
		{`"\u003c\u003e\u2028\u2029"`, "\"<>\u2028\u2029\""},
		{`"\ud83d\ude00"`, `"😀"`},
		{`"\ud800x\udfff"`, `"\ud800x\udfff"`},
		{`"a\/b\u0001\n\t\b\f\r\u0000"`, `"a/b\u0001\n\t\b\f\r\u0000"`},
		{`"literal\\u2028"`, `"literal\\u2028"`},
	} {
		units, err := DecodeJSONTextUnits(json.RawMessage(fixture.input))
		if err != nil {
			t.Fatal(err)
		}
		if got := string(EncodeJSONTextUnits(units)); got != fixture.canonical {
			t.Fatal("canonical JavaScript string spelling changed")
		}
	}
}

func TestJSONTextSlicesCodeUnitsWithoutRepairingLegacyTextOrAcceptingItAsIdentity(t *testing.T) {
	got, err := SliceJSONText(json.RawMessage(`"a😀z"`), 2)
	if err != nil || !bytes.Equal(got, []byte(`"a\ud83d"`)) {
		t.Fatal("UTF-16 slice was repaired")
	}
	if ValidUnicodeJSON(got) {
		t.Fatal("legacy user text was accepted as an identity")
	}
	for _, invalid := range []string{`null`, `true`, `"a" "b"`, `"\u12"`, "\"unescaped\ncontrol\""} {
		if _, err := DecodeJSONTextUnits([]byte(invalid)); err == nil {
			t.Fatal("invalid JSON string accepted")
		}
	}
}
