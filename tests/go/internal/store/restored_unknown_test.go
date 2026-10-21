package store

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func restoreUnknownFixture(t *testing.T, domain, field string, unknown json.RawMessage) []byte {
	t.Helper()
	entry := contracts.RawObject{
		"id":          json.RawMessage(`"49954ce5-c8c5-4f6e-a7d8-531530d09479"`),
		"status":      json.RawMessage(`"running"`),
		"role":        json.RawMessage(`"user"`),
		"text":        json.RawMessage(`"authored text"`),
		"turnId":      json.RawMessage(`"existing-turn"`),
		"turnIds":     json.RawMessage(`["existing-turn"]`),
		"title":       json.RawMessage(`"authored title"`),
		"source":      json.RawMessage(`"chat"`),
		"startedAt":   json.RawMessage(`17`),
		"updatedAt":   json.RawMessage(`23`),
		"plan":        json.RawMessage(`null`),
		"provisional": json.RawMessage(`true`),
	}
	entry[field] = unknown
	if field == "submission" {
		entry["status"] = json.RawMessage(`"completed"`)
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	root := contracts.RawObject{
		"conversationId": json.RawMessage(`"49954ce5-c8c5-4f6e-a7d8-531530d09479"`),
		"settings":       json.RawMessage(`{}`),
		"messages":       json.RawMessage(`[]`),
		"workTasks":      json.RawMessage(`[]`),
		"completions":    json.RawMessage(`[]`),
	}
	root[domain], _ = json.Marshal([]json.RawMessage{raw})
	result, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRestoredUnknownTaskMetadataNeverBecomesConfirmedOrSafelyReplayable(t *testing.T) {
	for _, domain := range []string{"messages", "workTasks"} {
		for _, field := range []string{"status", "submission"} {
			values := []string{`"future-state"`, `{ "future": true }`, `[1,2]`, `true`, `19`}
			if field == "status" {
				values = append(values, `null`)
			}
			for _, raw := range values {
				t.Run(domain+"/"+field+"/"+raw, func(t *testing.T) {
					original := restoreUnknownFixture(t, domain, field, json.RawMessage(raw))
					prepared, err := PauseRestoredState(original)
					if err != nil {
						t.Fatal("valid legacy state was rejected", err)
					}
					root, err := contracts.DecodeObject(prepared, MaxStateBytes)
					if err != nil {
						t.Fatal(err)
					}
					var entries []contracts.RawObject
					if json.Unmarshal(root[domain], &entries) != nil || len(entries) != 1 {
						t.Fatal("the original task identity was lost")
					}
					entry := entries[0]
					if !bytes.Equal(entry["unknownOutcome"], []byte("true")) {
						t.Fatal("unknown metadata became safely retryable")
					}
					var want bytes.Buffer
					if err := json.Compact(&want, []byte(raw)); err != nil {
						t.Fatal(err)
					}
					if !bytes.Equal(entry[field], want.Bytes()) {
						t.Fatal("unknown metadata was overwritten instead of retained as evidence")
					}
					state, err := ValidateRestoredState(prepared)
					if err != nil {
						t.Fatal("prepared state was no longer readable", err)
					}
					if domain == "messages" {
						if !state.Messages[0].UnknownOutcome || state.Messages[0].ID != "49954ce5-c8c5-4f6e-a7d8-531530d09479" {
							t.Fatal("the restored user task lost its identity or unknown fence")
						}
					} else if len(state.WorkTasks) != 1 || !state.WorkTasks[0].UnknownOutcome || state.WorkTasks[0].TurnID != "existing-turn" || state.WorkTasks[0].StartedAt != 17 || state.WorkTasks[0].UpdatedAt != 23 {
						t.Fatal("the restored work lost its identity, timestamps or unknown fence")
					}
				})
			}
		}
	}
}

func TestRestoredMalformedUnknownFlagCannotGrantSafeReplay(t *testing.T) {
	for _, domain := range []string{"messages", "workTasks"} {
		for _, malformed := range []string{`"true"`, `{}`, `[]`, `17`} {
			original := restoreUnknownFixture(t, domain, "unknownOutcome", json.RawMessage(malformed))
			prepared, err := PauseRestoredState(original)
			if err != nil {
				t.Fatal(err)
			}
			state, err := ValidateRestoredState(prepared)
			if err != nil {
				t.Fatal(err)
			}
			if domain == "messages" {
				if !state.Messages[0].UnknownOutcome || state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusUnknown) {
					t.Fatal("invalid uncertainty flag made a user task retryable")
				}
			} else if len(state.WorkTasks) != 1 || !state.WorkTasks[0].UnknownOutcome || state.WorkTasks[0].Status != contracts.WorkStatusUnknown {
				t.Fatal("invalid uncertainty flag made durable work retryable")
			}
		}
	}
}
