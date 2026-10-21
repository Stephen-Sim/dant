package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestWorkerPublicEmptyCollectionsAreArraysWithoutPersistingAbsentSchedules(t *testing.T) {
	app := fixtureWorker(t)
	stateFile := filepath.Join(app.options.Startup.DataDir, "state.json")
	before, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(before, &stored); err != nil {
		t.Fatal(err)
	}
	if _, present := stored["schedules"]; present {
		t.Fatal("fixture must preserve an absent legacy schedule field")
	}
	revision := app.store.Revision()

	response := callWorker(app, http.MethodGet, "/api/state", "")
	requireWorkerStatus(t, response, http.StatusOK)
	var state map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	array := func(name string, raw json.RawMessage) {
		t.Helper()
		var values []json.RawMessage
		if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &values) != nil || values == nil {
			t.Fatalf("public collection %s must be an array, got %s", name, raw)
		}
	}
	for _, name := range []string{"messages", "completions", "workTasks", "queue", "schedules", "memoryFiles"} {
		array(name, state[name])
	}
	for name, fields := range map[string][]string{
		"worker":       {"models"},
		"capabilities": {"languages"},
		"credentials":  {"items", "requests"},
		"skills":       {"items"},
	} {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(state[name], &nested); err != nil {
			t.Fatal(name, err)
		}
		for _, field := range fields {
			array(name+"."+field, nested[field])
		}
	}

	response = callWorker(app, http.MethodGet, "/api/schedules", "")
	requireWorkerStatus(t, response, http.StatusOK)
	var schedules map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &schedules); err != nil {
		t.Fatal(err)
	}
	array("schedule endpoint items", schedules["items"])
	after, err := os.ReadFile(stateFile)
	if err != nil || !bytes.Equal(after, before) || app.store.Revision() != revision || app.store.Snapshot().Schedules != nil {
		t.Fatal("public empty collections rewrote authoritative state or its absent schedule field", err)
	}
}

func TestWorkerPublicSchedulesPreservePopulatedOrderAndFields(t *testing.T) {
	app := fixtureWorker(t)
	items := []json.RawMessage{
		json.RawMessage(`{"id":"first","text":"kept first","at":1000,"status":"paused","futureField":{"kept":true}}`),
		json.RawMessage(`{"id":"second","text":"kept second","at":2000,"status":"unknown"}`),
	}
	if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
		state.Schedules = items
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(app.options.Startup.DataDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	revision := app.store.Revision()
	response := callWorker(app, http.MethodGet, "/api/state", "")
	requireWorkerStatus(t, response, http.StatusOK)
	var state struct{ Schedules []json.RawMessage }
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(items)
	got, _ := json.Marshal(state.Schedules)
	if !bytes.Equal(got, want) {
		t.Fatal("public schedules changed order or supported fields")
	}
	after, err := os.ReadFile(filepath.Join(app.options.Startup.DataDir, "state.json"))
	if err != nil || !bytes.Equal(after, before) || app.store.Revision() != revision {
		t.Fatal("snapshot rewrote populated authoritative schedules", err)
	}
}
