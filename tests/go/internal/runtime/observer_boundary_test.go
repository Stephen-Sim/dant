package runtime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestObserverRetainsOnlyValidatedExecutionMetadataAndBoundedAgentText(t *testing.T) {
	for _, duration := range []string{"7", "-1", "null", `"invalid"`} {
		item := contracts.RawObject{
			"id": []byte(`"command"`), "type": []byte(`"commandExecution"`), "status": []byte(`"completed"`),
			"durationMs": []byte(duration), "exitCode": []byte(`0`), "private": []byte(`"omitted"`),
		}
		metadata := observerItemMetadata(item)
		if string(metadata["exitCode"]) != "0" || metadata["private"] != nil {
			t.Fatal("observer lost a valid exit code or retained arbitrary metadata")
		}
		valid := duration == "7" || duration == "null"
		if valid && string(metadata["durationMs"]) != duration || !valid && metadata["durationMs"] != nil {
			t.Fatal("observer accepted invalid duration metadata")
		}
		item["exitCode"] = []byte(`1.5`)
		if observerItemMetadata(item)["exitCode"] != nil {
			t.Fatal("fractional exit code became execution evidence")
		}
	}
	text, _ := json.Marshal(strings.Repeat("a", ObserverAgentTextChars+100))
	event := observerEvent(t, contracts.RawObject{"id": []byte(`"answer"`), "type": []byte(`"agentMessage"`), "text": text})
	projected := PrepareObserverEvent(event)
	item, err := contracts.DecodeObject(projected.Params["item"], MaxRPCFrameBytes)
	if err != nil || projected.Projection != ObserverProjectionPayload {
		t.Fatal("agent output was not bounded at its observer boundary", err)
	}
	units, err := contracts.DecodeJSONTextUnits(item["text"])
	if err != nil || len(units) != ObserverAgentTextChars || string(event.Params["item"]) == string(projected.Params["item"]) {
		t.Fatal("observer changed the original item or exceeded its text bound", err)
	}
	invalidText := observerEvent(t, contracts.RawObject{"id": []byte(`"answer"`), "type": []byte(`"agentMessage"`), "text": []byte(`null`), "bulk": text})
	if got := PrepareObserverEvent(invalidText); got.Projection != ObserverProjectionNone || string(got.Params["item"]) != string(invalidText.Params["item"]) {
		t.Fatal("invalid agent text was invented during projection")
	}
}

func TestObserverUnrecognizedItemsNeverAcquireTaskExecutionEvidence(t *testing.T) {
	for _, item := range []contracts.RawObject{
		{"id": []byte(`"item"`), "type": []byte(`"unknown"`)},
		{"id": []byte(`""`), "type": []byte(`"commandExecution"`)},
		{"id": rawObserverString(t, strings.Repeat("x", 257)), "type": []byte(`"commandExecution"`)},
		{"id": []byte(`"item"`), "type": []byte(`"plan"`)},
	} {
		event := observerEvent(t, item)
		if got := PrepareObserverEvent(event); got.TaskExecutionObserved || string(got.Params["item"]) != string(event.Params["item"]) {
			t.Fatal("unrecognized item gained execution evidence or invented content")
		}
	}
}

func rawObserverString(t *testing.T, value string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
