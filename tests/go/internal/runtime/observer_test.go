package runtime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func observerEvent(t *testing.T, item contracts.RawObject) Event {
	t.Helper()
	raw, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	return Event{Method: "item/completed", Params: contracts.RawObject{"threadId": json.RawMessage(`"thread"`), "turnId": json.RawMessage(`"turn"`), "item": raw}}
}

func TestObserverOmitsImageBytesWithoutChangingTheOriginalOrLosingExecutionEvidence(t *testing.T) {
	item := contracts.RawObject{"id": json.RawMessage(`"screenshot"`), "type": json.RawMessage(`"mcpToolCall"`), "tool": json.RawMessage(`"screenshot"`), "result": json.RawMessage(`{"content":[{"type":"image","data":"private-image-bytes","mimeType":"image/png"},{"type":"text","text":"retained"}]}`)}
	event := observerEvent(t, item)
	projected := PrepareObserverEvent(event)
	if projected.Projection != ObserverProjectionImage || !projected.TaskExecutionObserved {
		t.Fatal("observer projection lost its fixed execution evidence")
	}
	if strings.Contains(string(projected.Params["item"]), "private-image-bytes") || !strings.Contains(string(event.Params["item"]), "private-image-bytes") {
		t.Fatal("projection either retained image data or changed the provider result")
	}
	wire, _ := json.Marshal(projected)
	if strings.Contains(string(wire), "Projection") || strings.Contains(string(wire), "TaskExecutionObserved") {
		t.Fatal("bookkeeping leaked onto the protocol")
	}
}

func TestObserverBoundsBulkPayloadButRetainsExactSuccessfulDeliveryReceipts(t *testing.T) {
	bulk, _ := json.Marshal(strings.Repeat("x", ObserverItemBytes+100))
	event := observerEvent(t, contracts.RawObject{"id": json.RawMessage(`"command"`), "type": json.RawMessage(`"commandExecution"`), "status": json.RawMessage(`"completed"`), "aggregatedOutput": bulk})
	projected := PrepareObserverEvent(event)
	if projected.Projection != ObserverProjectionPayload || strings.Contains(string(projected.Params["item"]), "aggregatedOutput") || !projected.TaskExecutionObserved {
		t.Fatal("bulk observer data was not bounded safely")
	}
	delivery := observerEvent(t, contracts.RawObject{"id": json.RawMessage(`"delivery"`), "type": json.RawMessage(`"mcpToolCall"`), "server": json.RawMessage(`"dant_desktop"`), "tool": json.RawMessage(`"send_chat_message"`), "status": json.RawMessage(`"completed"`), "arguments": bulk})
	if got := PrepareObserverEvent(delivery); string(got.Params["item"]) != string(delivery.Params["item"]) {
		t.Fatal("matching delivery receipt was projected away")
	}
	delivery.ID = contracts.Some(NumericRPCID(9))
	if got := PrepareObserverEvent(delivery); string(got.Params["item"]) != string(delivery.Params["item"]) {
		t.Fatal("a provider request was treated as an observer notification")
	}
}

func TestObserverUTF16TextLimitPreservesSplitSurrogate(t *testing.T) {
	text, _ := json.Marshal(strings.Repeat("a", ObserverAgentTextChars-1) + "😀")
	event := Event{Method: "item/agentMessage/delta", Params: contracts.RawObject{"itemId": json.RawMessage(`"assistant"`), "delta": text}}
	projected := PrepareObserverEvent(event)
	if projected.Projection != ObserverProjectionPayload || !strings.HasSuffix(string(projected.Params["delta"]), `\ud83d"`) {
		t.Fatal("observer repaired a UTF-16 truncation boundary")
	}
}
