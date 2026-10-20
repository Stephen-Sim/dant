package runtime

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestProviderResultsValidateKnownFieldsWithoutRewritingOpaqueExtensions(t *testing.T) {
	fixture := json.RawMessage(`{"thread":{"id":"thread-original","turns":[{"id":"turn-original","items":[{"id":"item","type":"agentMessage","text":"legacy\ud800","phase":null,"content":[{"type":"text","text":"literal"}]}]}],"status":{"type":"idle"}},"turn":{"id":"turn-original","startedAt":null},"account":null,"authMode":null,"requiresOpenaiAuth":false,"voices":{"v3":["marin"]},"future":{"text":"\ud801"}}`)
	result, err := ReadRPCResult(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result["future"], []byte(`{"text":"\ud801"}`)) || !bytes.Contains(result["thread"], []byte(`legacy\ud800`)) {
		t.Fatal("provider text or opaque fields were rewritten")
	}
}

func TestMalformedProviderFieldsCannotBecomeAcknowledgedExecutions(t *testing.T) {
	for _, fixture := range []string{
		`{"turn":{"id":"\ud800"}}`, `{"turn":{"id":false}}`, `{"thread":null}`,
		`{"thread":{"id":"t","turns":[{"id":"x","items":[{"id":"i","type":"reasoning","content":[{}]}]}]}}`,
		`{"turn":{"id":"t","items":[{"id":"i","type":"fileChange","changes":[{"kind":null}]}]}}`,
		`{"turn":{"id":"t","items":[{"id":"i","type":"agentMessage","exitCode":"0"}]}}`,
		`{"turn":{"id":"t","items":[{"id":"i","type":"mcpToolCall","result":{"isError":null}}]}}`,
		`{"turn":{"id":"t","items":[{"id":"i","type":"agentMessage","active_transcript":[{"role":"user"}]}]}}`,
		`{"account":{"email":null}}`, `{"voices":{"v3":null}}`, `{"requiresOpenaiAuth":null}`,
	} {
		if _, err := ReadRPCResult(json.RawMessage(fixture)); err == nil {
			t.Fatal("malformed provider field was accepted")
		}
	}
}
