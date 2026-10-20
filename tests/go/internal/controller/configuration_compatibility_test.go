package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestControllerConfigurationReadsLegacyPreferencesWithoutDiscardingExtensions(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "controller.json")
	legacy := []byte(`{"language":"en","theme":"dark","fontSize":17,"notifications":true,"showWorkSummary":true,"showCallCaptions":false,"serviceUpdatesPaused":true,"futurePreference":{"enabled":true}}`)
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, legacy...), 0600); err != nil {
		t.Fatal(err)
	}

	value := readConfiguration(directory)
	if value.Language != "en" || value.Theme != "dark" || value.FontSize != 17 || !value.Notifications || !value.ShowWorkSummary || value.ShowCallCaptions || !value.ServiceUpdatesPaused {
		t.Fatal("legacy local preferences were not retained")
	}
	if len(value.Extra) != 1 || string(value.Extra["futurePreference"]) != `{"enabled":true}` {
		t.Fatal("unknown preference was discarded or known values leaked into extensions")
	}

	value.Extra["language"] = json.RawMessage(`"unsupported-overwrite"`)
	raw, err := json.Marshal(value)
	if err != nil || !bytes.Contains(raw, []byte(`"language":"en"`)) || !bytes.Contains(raw, []byte(`"futurePreference":{"enabled":true}`)) {
		t.Fatal("preference rewrite lost extensions or allowed them to override owned fields")
	}
}

func TestControllerConfigurationDefaultsForMissingUnsafeAndMalformedFiles(t *testing.T) {
	for _, fixture := range []struct {
		name string
		raw  string
	}{
		{"invalid-json", `{`},
		{"array", `[]`},
		{"null", `null`},
		{"oversized", strings.Repeat(" ", controllerConfigLimit+1)},
		{"invalid-values", `{"language":"unsupported","theme":"invalid","fontSize":100,"showCallCaptions":null,"notifications":"true"}`},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "controller.json"), []byte(fixture.raw), 0600); err != nil {
				t.Fatal(err)
			}
			value := readConfiguration(directory)
			if value.Language != "zh" || value.Theme != "system" || value.FontSize != 13 || !value.ShowCallCaptions || value.Notifications {
				t.Fatal("invalid local data replaced safe display defaults")
			}
		})
	}

	directory := t.TempDir()
	if got := readConfiguration(directory); !reflect.DeepEqual(got, defaultConfiguration()) {
		t.Fatal("missing configuration did not use defaults")
	}
	if err := os.Mkdir(filepath.Join(directory, "controller.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if got := readConfiguration(directory); !reflect.DeepEqual(got, defaultConfiguration()) {
		t.Fatal("directory was consumed as a preference file")
	}
}

func TestControllerConfigurationCommitsMemoryOnlyAfterDurableWrite(t *testing.T) {
	app := &App{options: Options{DataDir: t.TempDir()}, configuration: defaultConfiguration()}
	next := defaultConfiguration()
	next.Language = "en"
	next.Extra["future"] = json.RawMessage(`{"count":2}`)
	if err := app.persistConfiguration(context.Background(), next); err != nil {
		t.Fatal(err)
	}
	if readConfiguration(app.options.DataDir).Language != "en" || app.configuration.Language != "en" {
		t.Fatal("successful write did not update both durable and visible preferences")
	}

	failed := next
	failed.Language = "zh"
	failed.Extra = contracts.RawObject{"invalid": json.RawMessage(`{`)}
	if err := app.persistConfiguration(context.Background(), failed); err == nil || app.configuration.Language != "en" {
		t.Fatal("invalid JSON committed an in-memory preference")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	failed.Extra = nil
	if err := app.persistConfiguration(ctx, failed); err == nil || app.configuration.Language != "en" || readConfiguration(app.options.DataDir).Language != "en" {
		t.Fatal("cancelled persistence changed local preferences")
	}
}

func TestControllerCachePreservesHistoryAndExcludesTransientCaptions(t *testing.T) {
	directory := t.TempDir()
	state := emptyWorkerSnapshot()
	state.ConversationID = "fixture-conversation"
	state.Messages = []*contracts.ChatMessage{{ID: "fixture-message", Role: "assistant", Text: "isolated history"}}
	state.Extra["callCaption"] = json.RawMessage(`{"text":"transient only"}`)
	state.Extra["futureState"] = json.RawMessage(`{"count":3}`)
	app := &App{ctx: context.Background(), options: Options{DataDir: directory, Now: func() time.Time { return time.UnixMilli(123456) }}}
	app.saveCache(state)
	if app.lastSaved != 123456 {
		t.Fatal("durable cache save did not record its timestamp")
	}
	actual := readCached(directory)
	if actual.ConversationID != state.ConversationID || len(actual.Messages) != 1 || actual.Messages[0].Text != "isolated history" || actual.Extra["callCaption"] != nil || string(actual.Extra["futureState"]) != `{"count":3}` {
		t.Fatal("cached history lost identity, extensions, or transient-state boundary")
	}

	app.saveCache(contracts.WorkerSnapshot{Extra: contracts.RawObject{"invalid": json.RawMessage(`{`)}})
	if readCached(directory).ConversationID != state.ConversationID || app.lastSaved != 123456 {
		t.Fatal("failed cache serialization replaced the last valid history")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	app.ctx = ctx
	app.saveCache(emptyWorkerSnapshot())
	if readCached(directory).ConversationID != state.ConversationID {
		t.Fatal("cancelled cache write discarded durable history")
	}
}

func TestControllerCacheRejectsInvalidObjectsAndRemovesCaptionsOnRead(t *testing.T) {
	for _, raw := range []string{`[]`, `{`, `null`, `{"messages":false}`} {
		directory := t.TempDir()
		if err := os.WriteFile(filepath.Join(directory, "state-cache.json"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		state := readCached(directory)
		if state.ConversationID != "" || state.Worker.Status != contracts.ConnectionStatusOffline || state.Messages == nil || state.Queue == nil {
			t.Fatal("invalid cache did not produce an explicit empty offline state")
		}
	}
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "state-cache.json"), []byte(`{"conversationId":"fixture","callCaption":{"text":"must not survive"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if state := readCached(directory); state.ConversationID != "fixture" || state.Extra["callCaption"] != nil {
		t.Fatal("legacy cache revived a transient caption")
	}
}
