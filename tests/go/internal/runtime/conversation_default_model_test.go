package runtime

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestConversationCatalogPreservesOnlyOneValidCapturedDefault(t *testing.T) {
	for _, fixture := range []struct{ data, model string }{
		{"", ""}, {`null`, ""}, {`[]`, ""}, {`[{"id":"legacy"}]`, ""},
		{`[{"model":"other","isDefault":false},{"id":"metadata-id","model":"actual-default","isDefault":true}]`, "actual-default"},
	} {
		model, err := conversationCatalogDefault(json.RawMessage(fixture.data))
		if err != nil || model != fixture.model {
			t.Fatal("captured model default changed", err)
		}
	}
	for _, data := range []string{`false`, `{}`, `[null]`, `[{"isDefault":"yes"}]`, `[{"isDefault":null}]`, `[{"isDefault":true}]`, `[{"model":"bad\nmodel","isDefault":true}]`, `[{"model":"one","isDefault":true},{"model":"two","isDefault":true}]`} {
		if _, err := conversationCatalogDefault(json.RawMessage(data)); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid or ambiguous default became a model selection", err)
		}
	}
}
