package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func persistedPresenceMessages(t *testing.T, file string) []contracts.RawObject {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Messages []contracts.RawObject `json:"messages"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state.Messages
}

func TestPersistedMessagePresenceSurvivesRepeatedOpenAndUnrelatedMutations(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, stateFileName)
	messages := `[{"id":"absent","role":"assistant","status":"completed"},{"id":"zeros","role":"assistant","text":"","status":"completed","attachments":[],"reactions":[],"voice":false,"scheduled":false,"workId":"","turnIds":[],"messageIds":[]},{"id":"nulls","role":"assistant","text":null,"status":"completed","read":null,"reactions":null,"attachments":null,"voice":null,"kind":null},{"id":"nested","role":"assistant","status":"completed","text":"old\ud800text","attachments":[{"id":"file","name":"","type":null,"transcription":null,"size":0,"unavailable":false}]}]`
	input := []byte(`{"version":2,"conversationId":"` + conversationID + `","messages":` + messages + `,"workTasks":[],"completions":[]}`)
	if err := os.WriteFile(file, input, 0o600); err != nil {
		t.Fatal(err)
	}
	var expected []contracts.RawObject
	if err := json.Unmarshal([]byte(messages), &expected); err != nil {
		t.Fatal(err)
	}
	for cycle := range 3 {
		value, err := Open(directory, Options{})
		if err != nil {
			t.Fatal(err)
		}
		if err := value.Mutate(context.Background(), func(state *contracts.State) error {
			state.Settings.ShowWorkSummary = cycle%2 == 0
			return nil
		}); err != nil {
			value.Close()
			t.Fatal(err)
		}
		value.Close()
		current := persistedPresenceMessages(t, file)
		var currentValues, expectedValues any
		if json.Unmarshal(mustPresenceJSON(t, current), &currentValues) != nil || json.Unmarshal(mustPresenceJSON(t, expected), &expectedValues) != nil {
			t.Fatal("persisted message JSON became invalid")
		}
		if !reflect.DeepEqual(currentValues, expectedValues) {
			t.Fatalf("cycle %d rewrote existing message fields: %s", cycle, mustPresenceJSON(t, current))
		}
	}
}

func mustPresenceJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPresenceRetentionCannotResurrectUnknownTaskOrSubmissionStates(t *testing.T) {
	for _, unknownField := range []string{"", `,"unknownOutcome":null`, `,"unknownOutcome":false`} {
		raw := []byte(`{"version":2,"conversationId":"` + conversationID + `","messages":[{"id":"unsafe","role":"user","status":"invented-success","submission":"retry-safe","text":"","attachments":[],"voice":false` + unknownField + `}],"workTasks":[],"completions":[]}`)
		state, err := restore(raw, UUID, true)
		if err != nil {
			t.Fatal(err)
		}
		message := state.Messages[0]
		if message.Status.Value != contracts.MessageStatus(contracts.TaskStatusUnknown) || message.Submission.Value != contracts.SubmissionStatusUnknown || !message.UnknownOutcome {
			t.Fatal("unknown runtime state was normalized into a safe execution state")
		}
		encoded := mustPresenceJSON(t, message)
		var fields contracts.RawObject
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["status"]) != `"unknown"` || string(fields["submission"]) != `"unknown"` || string(fields["unknownOutcome"]) != "true" || string(fields["attachments"]) != "[]" || string(fields["voice"]) != "false" {
			t.Fatal("normalization lost presence or restored invalid enum bytes", fields)
		}
	}
}

func TestPersistedPresenceRetainsExplicitEmptyAndNullEdits(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, stateFileName)
	input := []byte(`{"version":2,"conversationId":"` + conversationID + `","messages":[{"id":"edited","role":"assistant","status":"completed","text":null,"voice":true,"attachments":[{"id":"file","name":"before"}]}],"workTasks":[],"completions":[]}`)
	if err := os.WriteFile(file, input, 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer value.Close()
	for _, patch := range []contracts.MessagePatch{
		{"text": json.RawMessage(`""`), "voice": json.RawMessage("false"), "attachments": json.RawMessage("[]")},
		{"attachments": json.RawMessage("null")},
	} {
		if _, err := value.Update(context.Background(), "edited", patch); err != nil {
			t.Fatal(err)
		}
		fields := persistedPresenceMessages(t, file)[0]
		for key, expected := range patch {
			if compact(fields[key]) != string(expected) {
				t.Fatal("an explicit current edit was replaced by historical presence", key, fields)
			}
		}
	}
}
