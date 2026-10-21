package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type stateWireContract interface {
	json.Marshaler
	json.Unmarshaler
	Valid() bool
}

func TestEveryStateDomainPreservesCanonicalWiresAndRejectsUnknownValues(t *testing.T) {
	factories := map[string]func() stateWireContract{
		"AppUpdateStatus":           func() stateWireContract { return new(AppUpdateStatus) },
		"BackupMode":                func() stateWireContract { return new(BackupMode) },
		"BackupPhase":               func() stateWireContract { return new(BackupPhase) },
		"ChatTaskStatus":            func() stateWireContract { return new(ChatTaskStatus) },
		"ComputerControlStatus":     func() stateWireContract { return new(ComputerControlStatus) },
		"ConnectionStatus":          func() stateWireContract { return new(ConnectionStatus) },
		"ContinuationDispatchPhase": func() stateWireContract { return new(ContinuationDispatchPhase) },
		"DesktopPhase":              func() stateWireContract { return new(DesktopPhase) },
		"HostPlatformId":            func() stateWireContract { return new(HostPlatformId) },
		"MemoryEntryStatus":         func() stateWireContract { return new(MemoryEntryStatus) },
		"PlanStepStatus":            func() stateWireContract { return new(PlanStepStatus) },
		"ProvisioningStatus":        func() stateWireContract { return new(ProvisioningStatus) },
		"RecordingDraftStatus":      func() stateWireContract { return new(RecordingDraftStatus) },
		"ScheduleDispatchPhase":     func() stateWireContract { return new(ScheduleDispatchPhase) },
		"ScheduleStatus":            func() stateWireContract { return new(ScheduleStatus) },
		"ServiceUpdateStatus":       func() stateWireContract { return new(ServiceUpdateStatus) },
		"SubmissionStatus":          func() stateWireContract { return new(SubmissionStatus) },
		"LiveContextStatus":         func() stateWireContract { return new(LiveContextStatus) },
		"TaskPriority":              func() stateWireContract { return new(TaskPriority) },
		"TaskProgressStage":         func() stateWireContract { return new(TaskProgressStage) },
		"TaskStatus":                func() stateWireContract { return new(TaskStatus) },
		"UpdateDownloadStatus":      func() stateWireContract { return new(UpdateDownloadStatus) },
		"VoiceCallStatus":           func() stateWireContract { return new(VoiceCallStatus) },
		"VmPowerState":              func() stateWireContract { return new(VmPowerState) },
		"VmProviderId":              func() stateWireContract { return new(VmProviderId) },
		"VmReceiptPhase":            func() stateWireContract { return new(VmReceiptPhase) },
		"WorkStatus":                func() stateWireContract { return new(WorkStatus) },
		"WorkerInstallationPhase":   func() stateWireContract { return new(WorkerInstallationPhase) },
		"WorkerRestorePhase":        func() stateWireContract { return new(WorkerRestorePhase) },
		"RuntimeOperatingSystem":    func() stateWireContract { return new(RuntimeOperatingSystem) },
		"RuntimeTerminalTurnStatus": func() stateWireContract { return new(RuntimeTerminalTurnStatus) },
		"SpokenReferenceStatus":     func() stateWireContract { return new(SpokenReferenceStatus) },
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "resources", "contracts", "state-domains.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Version int                          `json:"version"`
		Domains map[string]map[string]string `json:"domains"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Version != 1 || len(schema.Domains) != len(factories) {
		t.Fatal("the canonical state vocabulary lacks an executable boundary test")
	}
	for name, values := range schema.Domains {
		t.Run(name, func(t *testing.T) {
			create := factories[name]
			if create == nil || len(values) == 0 {
				t.Fatal("missing or empty state domain")
			}
			for key, wire := range values {
				t.Run(key, func(t *testing.T) {
					value := create()
					encoded, err := json.Marshal(wire)
					if err != nil {
						t.Fatal(err)
					}
					if err := value.UnmarshalJSON(encoded); err != nil || !value.Valid() {
						t.Fatal("canonical wire was rejected", err)
					}
					actual, err := value.MarshalJSON()
					if err != nil || !bytes.Equal(actual, encoded) {
						t.Fatal("persisted canonical wire changed", err)
					}
					for _, invalid := range []string{`null`, `false`, `17`, `[]`, `{}`, `""`, `"unknown-wire"`, `"`, `"valid" true`} {
						if err := value.UnmarshalJSON([]byte(invalid)); err == nil {
							t.Fatalf("accepted invalid state input %q", invalid)
						}
						after, err := value.MarshalJSON()
						if err != nil || !bytes.Equal(after, encoded) {
							t.Fatal("rejected input replaced a retained state", err)
						}
					}
				})
			}
			invalid := create()
			reflect.ValueOf(invalid).Elem().SetString("unknown-wire")
			if invalid.Valid() {
				t.Fatal("unknown in-memory value became a valid domain state")
			}
			if raw, err := invalid.MarshalJSON(); err == nil || len(raw) != 0 {
				t.Fatal("unknown state escaped through serialization")
			}
		})
	}
}

func TestExtendedDTOsRejectMalformedObjectsAndDuplicateFields(t *testing.T) {
	values := []json.Unmarshaler{&Attachment{}, &VMSettings{}, &Settings{}, &ChatMessage{}, &WorkRecord{}, &Completion{}, &State{}, &WorkerSnapshot{}, &PlanStep{}, &TaskPlan{}, &WorkReplyTarget{}, &ContinuationDispatch{}, &WorkContinuation{}}
	for _, value := range values {
		for _, raw := range []string{`null`, `[]`, `{"id":"x","id":"y"}`, `{`} {
			if err := value.UnmarshalJSON([]byte(raw)); err == nil {
				t.Fatalf("%T accepted malformed disk or transport data", value)
			}
		}
	}
}

func TestContinuationDispatchPreservesLegacyAcceptanceWithoutInventingANewPhase(t *testing.T) {
	var dispatch ContinuationDispatch
	raw := []byte(`{"id":"synthetic-dispatch","phase":"accepted","createdAt":0,"future":true}`)
	if err := json.Unmarshal(raw, &dispatch); err != nil || dispatch.Phase != ContinuationDispatchPhaseAcknowledged {
		t.Fatal("legacy acceptance did not retain its confirmed binding semantics", err)
	}
	encoded, err := json.Marshal(dispatch)
	if err != nil || !bytes.Contains(encoded, []byte(`"phase":"accepted"`)) || !bytes.Contains(encoded, []byte(`"future":true`)) {
		t.Fatal("an unrelated serialization rewrote a supported legacy receipt", err)
	}
	for _, invalid := range []string{`{"phase":"unknown-phase"}`, `{"phase":false}`} {
		if err := json.Unmarshal([]byte(invalid), &dispatch); err == nil || dispatch.Phase != ContinuationDispatchPhaseAcknowledged {
			t.Fatal("invalid receipt changed an existing dispatch owner", err)
		}
	}
	if raw, err := json.Marshal(WorkRecord{Status: WorkStatus("invalid")}); err == nil || len(raw) != 0 {
		t.Fatal("an invalid durable status escaped through its containing DTO")
	}
}

func TestMalformedJSONStructureAndTextLimitsReturnTheirFixedBoundaryErrors(t *testing.T) {
	for _, input := range []string{`{1:0}`, `{"a":1`, `{"a":[1,2}`, `{"a":]}`, `{"a":{`, `{"a":[1,}`, `{"a":true`, `{"a":1,`} {
		if _, err := DecodeObject([]byte(input), 1024); err == nil {
			t.Fatal("incomplete object or array was accepted")
		}
	}
	if _, err := SliceJSONText(json.RawMessage(`"unchanged"`), -1); err != ErrJSONText {
		t.Fatal("negative text limit was accepted", err)
	}
	if _, err := SliceJSONText(json.RawMessage(`null`), 1); err != ErrJSONText {
		t.Fatal("non-text value was accepted as user text", err)
	}
	if actual := (&APIError{Status: 400, Code: "fixed-code", Message: "public text"}).Error(); actual != "fixed-code" {
		t.Fatal("public boundary error exposed more than its fixed code")
	}
}
