package runtime

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestProviderResultRejectsMalformedConsumedFieldsWithoutRepairingIdentities(t *testing.T) {
	for _, raw := range []string{
		`{"status":false}`, `{"thread":{"id":"thread","status":{"type":false}}}`, `{"thread":{"id":"thread","turns":[{"id":"turn","startedAt":"bad"}]}}`, `{"turn":{"id":"turn","error":{"message":false}}}`, `{"account":false}`, `{"account":{"email":false}}`, `{"authMode":false}`, `{"requiresOpenaiAuth":null}`, `{"voices":false}`, `{"voices":{"v3":[false]}}`,
	} {
		if _, err := ReadRPCResult(json.RawMessage(raw)); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("malformed consumed provider field was accepted", err)
		}
	}
	for _, item := range []string{
		`false`, `{"id":"item","type":"message","phase":false}`, `{"id":"item","type":"message","exitCode":"bad"}`, `{"id":"item","type":"message","error":false}`, `{"id":"item","type":"message","error":{"message":false}}`,
		`{"id":"item","type":"tool","result":[]}`, `{"id":"item","type":"tool","result":{"isError":null}}`, `{"id":"item","type":"tool","result":{"content":false}}`,
		`{"id":"item","type":"message","content":[{"type":false}]}`, `{"id":"item","type":"reasoning","content":[false]}`,
		`{"id":"item","type":"fileChange","changes":[false]}`, `{"id":"item","type":"fileChange","changes":[{"path":false}]}`, `{"id":"item","type":"fileChange","changes":[{"kind":false}]}`,
		`{"id":"item","type":"commandExecution","commandActions":[false]}`, `{"id":"item","type":"handoff","active_transcript":[{"role":"user","text":false}]}`,
	} {
		raw := `{"turn":{"id":"turn","items":[` + item + `]}}`
		if _, err := ReadRPCResult(json.RawMessage(raw)); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("malformed nested provider item was accepted", err)
		}
	}
}

func TestProviderResultAcceptsValidatedNestedFormsAndRetainsOpaqueToolContent(t *testing.T) {
	raw := json.RawMessage(`{"thread":{"id":"thread","status":"idle","turns":[{"id":"turn","startedAt":1,"error":{"message":"classified"},"items":[{"id":"tool","type":"mcpToolCall","result":{"isError":false,"content":[{"future":true}]}},{"id":"reasoning","type":"reasoning","content":["authored thought"]},{"id":"files","type":"fileChange","changes":[{"path":"file","kind":{"type":"update"},"diff":"authored diff"}]},{"id":"command","type":"commandExecution","commandActions":[{"type":"read"}],"exitCode":0,"durationMs":1,"error":null},{"id":"handoff","type":"handoff","active_transcript":[{"role":"user","text":"authored speech"}]}]}]},"account":{"type":"fixture","email":"fixture@example.invalid","planType":"fixture"},"voices":{"v3":["ember"]}}`)
	result, err := ReadRPCResult(raw)
	if err != nil || len(result["thread"]) == 0 || len(result["account"]) == 0 {
		t.Fatal("valid nested provider result was rejected", err)
	}
	if _, err := ReadRPCResult(json.RawMessage(`{"turn":{"id":"turn","items":[{"id":"tool","type":"mcpToolCall","result":{}}]}}`)); err != nil {
		t.Fatal("absent optional tool result fields were invented as errors", err)
	}
}
