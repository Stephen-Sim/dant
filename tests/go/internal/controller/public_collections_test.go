package controller

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestControllerPublicSchedulesAdaptOnlyCachedNullWithoutRewritingCache(t *testing.T) {
	app, _, server, token := controllerAppFixture(t)
	for _, fixture := range []struct {
		name, stored, expected string
	}{
		{"null", "null", "[]"},
		{"spaced-null", " \n null \t", "[]"},
		{"empty", "[]", "[]"},
		{"populated", `[{"id":"kept","status":"paused"}]`, `[{"id":"kept","status":"paused"}]`},
		{"unknown-object", `{"unexpected":true}`, `{"unexpected":true}`},
		{"unknown-string", `"unexpected"`, `"unexpected"`},
		{"missing", "", ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			cached := emptyWorkerSnapshot()
			if fixture.stored == "" {
				delete(cached.Extra, "schedules")
			} else {
				cached.Extra["schedules"] = json.RawMessage(fixture.stored)
			}
			raw, err := json.Marshal(cached)
			if err != nil {
				t.Fatal(err)
			}
			cacheFile := filepath.Join(app.options.DataDir, "state-cache.json")
			if err := os.WriteFile(cacheFile, raw, 0600); err != nil {
				t.Fatal(err)
			}
			app.mu.Lock()
			app.cached = cached
			app.mu.Unlock()

			response := controllerRequest(t, server, token, http.MethodGet, "/api/state", "")
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatal("cached state unavailable", response.StatusCode)
			}
			var state map[string]json.RawMessage
			if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
				t.Fatal(err)
			}
			if string(state["schedules"]) != fixture.expected {
				t.Fatalf("schedule display copy: got %s, want %s", state["schedules"], fixture.expected)
			}
			after, err := os.ReadFile(cacheFile)
			if err != nil || !bytes.Equal(after, raw) {
				t.Fatal("display adaptation rewrote saved cache", err)
			}
			app.mu.Lock()
			saved := append(json.RawMessage{}, app.cached.Extra["schedules"]...)
			app.mu.Unlock()
			if string(saved) != fixture.stored {
				t.Fatal("display adaptation rewrote the retained cached projection")
			}
		})
	}
}
