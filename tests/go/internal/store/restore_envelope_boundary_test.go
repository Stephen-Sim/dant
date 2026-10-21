package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestBackupEnvelopeValidationRejectsMalformedArraysSettingsAndMessageIdentities(t *testing.T) {
	s, _ := openFixture(t)
	encoded, err := json.Marshal(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}

	for _, scenario := range []string{"invalid JSON", "missing array", "wrong array", "wrong settings", "scalar message", "missing message identity"} {
		t.Run(scenario, func(t *testing.T) {
			var object contracts.RawObject
			if err := json.Unmarshal(encoded, &object); err != nil {
				t.Fatal(err)
			}

			switch scenario {
			case "missing array":
				delete(object, "completions")
			case "wrong array":
				object["workTasks"] = json.RawMessage(`null`)
			case "wrong settings":
				object["settings"] = json.RawMessage(`[]`)
			case "scalar message":
				object["messages"] = json.RawMessage(`[7]`)
			case "missing message identity":
				object["messages"] = json.RawMessage(`[{"role":"user"}]`)
			}

			input, err := json.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "invalid JSON" {
				input = []byte(`{"conversationId":`)
			}

			if _, err := ValidateRestoredState(input); !errors.Is(err, ErrInvalidState) {
				t.Fatal("malformed backup envelope became a restored conversation", err)
			}
			if _, err := PauseRestoredState(input); !errors.Is(err, ErrInvalidState) {
				t.Fatal("malformed backup staging was reported ready for restoration", err)
			}
		})
	}
}

func TestBackupStagingRetainsUnrecognizedHistoryAndRejectsMalformedContinuationObjects(t *testing.T) {
	for _, malformed := range []string{"continuation", "dispatch"} {
		t.Run(malformed, func(t *testing.T) {
			s, _, _, _ := progressFixture(t)
			encoded, err := json.Marshal(s.Snapshot())
			if err != nil {
				t.Fatal(err)
			}
			var object contracts.RawObject
			if err := json.Unmarshal(encoded, &object); err != nil {
				t.Fatal(err)
			}
			var records []contracts.RawObject
			if err := json.Unmarshal(object["workTasks"], &records); err != nil {
				t.Fatal(err)
			}

			records[0]["continuation"] = json.RawMessage(`"malformed continuation"`)
			if malformed == "dispatch" {
				records[0]["continuation"] = json.RawMessage(`{"nextAt":8,"dispatch":7}`)
			}
			object["workTasks"], err = json.Marshal(records)
			if err != nil {
				t.Fatal(err)
			}
			input, err := json.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := PauseRestoredState(input); !errors.Is(err, ErrInvalidState) {
				t.Fatal("malformed continuation lost its uncertainty during backup staging", err)
			}
		})
	}

	s, _ := openFixture(t)
	encoded, err := json.Marshal(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	var object contracts.RawObject
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	object["callInputHistory"] = json.RawMessage(`[7,{"submission":"pending","text":"legacy\ud800"}]`)
	input, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PauseRestoredState(input)
	if err != nil || !bytes.Contains(prepared, []byte(`7,{"submission":"unknown","text":"legacy\ud800"}`)) {
		t.Fatal("backup staging discarded unfamiliar history or altered legacy text", err)
	}
}
