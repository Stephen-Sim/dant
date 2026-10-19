package contracts

import (
	"encoding/json"
	"testing"
)

func TestUnknownWireDoesNotReplaceExistingState(t *testing.T) {
	for _, input := range []string{`null`, `false`, `0`, `""`, `"new-unknown-state"`, `[]`, `{}`} {
		state := WorkStatusPaused
		if err := json.Unmarshal([]byte(input), &state); err == nil {
			t.Fatalf("accepted an invalid state: %s", input)
		}
		if state != WorkStatusPaused {
			t.Fatal("invalid input changed a previously paused state")
		}
	}
}

func TestTaskVocabulariesRemainDistinct(t *testing.T) {
	if !TaskStatusDraft.Valid() || WorkStatus(TaskStatusDraft).Valid() {
		t.Fatal("durable work accepted a UI draft")
	}
	if !WorkStatusUnknown.Valid() || ChatTaskStatus(WorkStatusUnknown).Valid() {
		t.Fatal("chat validation broadened to the durable unknown vocabulary")
	}
	if _, err := json.Marshal(WorkStatus("invalid")); err == nil {
		t.Fatal("serialized an unknown state")
	}
	var decoded WorkStatus
	if err := json.Unmarshal([]byte(`"paused"`), &decoded); err != nil || decoded != WorkStatusPaused {
		t.Fatal("paused wire state did not round-trip")
	}
	encoded, err := json.Marshal(decoded)
	if err != nil || string(encoded) != `"paused"` {
		t.Fatal("changed a stable persisted wire value")
	}
}
