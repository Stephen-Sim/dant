package runtime

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRPCIdentifierDecodingPreservesNumericZeroAndRejectsUnsetValues(t *testing.T) {
	var id RPCID
	if _, err := id.MarshalJSON(); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("unset RPC ID became an outbound identity", err)
	}
	for _, raw := range []string{"-0", "0", "0.0", "0e0"} {
		if err := id.UnmarshalJSON([]byte(raw)); err != nil || id.Key() != "n:0" {
			t.Fatal("numeric zero acquired a different correlation key", err)
		}
		encoded, err := id.MarshalJSON()
		if err != nil || string(encoded) != raw {
			t.Fatal("zero spelling changed in a provider reply", err)
		}
	}
	if err := id.UnmarshalJSON([]byte(`true`)); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("invalid ID overwritten a validated correlation", err)
	}
	if id.Key() != "n:0" {
		t.Fatal("failed decode changed the previous identifier")
	}
	err := &OperationError{UnknownOutcome: true}
	if err.Error() != ErrRequestFailed.Error() || !err.UnconfirmedOutcome() || err.Unwrap() != nil {
		t.Fatal("unknown operation without a provider cause lost its fixed error")
	}
}

func TestEventDecodingRejectsMalformedConsumedFieldsAndKeepsNullIDsDistinct(t *testing.T) {
	for _, raw := range []string{`{}`, `{"method":null}`, `{"method":""}`, `{"method":"\ud800"}`, `{"method":"notice","params":[]}`, `{"method":"notice","id":true}`} {
		var object contracts.RawObject
		if err := json.Unmarshal([]byte(raw), &object); err != nil {
			t.Fatal(err)
		}
		if _, err := decodeEvent(object); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("malformed event acquired execution authority", err)
		}
	}
	for _, raw := range []string{`{"method":"notice"}`, `{"method":"notice","id":null}`} {
		var object contracts.RawObject
		if err := json.Unmarshal([]byte(raw), &object); err != nil {
			t.Fatal(err)
		}
		event, err := decodeEvent(object)
		if err != nil || event.Params == nil || event.IsRequest() {
			t.Fatal("notification acquired a provider request ID", err)
		}
		if strings.Contains(raw, "null") && (!event.ID.Present || !event.ID.Null) {
			t.Fatal("explicitly null provider ID became absent")
		}
	}
}
