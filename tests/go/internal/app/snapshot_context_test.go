package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func snapshotContextFixture(t *testing.T) *WorkerApp {
	t.Helper()
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Preserved original request"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "Preserved step", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := app.store.RegisterWork(t.Context(), store.RegisterWorkOptions{
		TurnID: "context-turn", MessageID: message.ID, Source: "chat", Title: "Preserved task", Plan: &plan,
	})
	if err != nil {
		t.Fatal(err)
	}
	private := json.RawMessage(`{"referenceDataOnly":true,"originalRequest":"private-context-fixture"}`)
	work := contracts.RawObject{
		"id": encode(record.ID), "turnId": encode(record.TurnID),
		"contextSummary": encode("Visible context summary"),
		"future":         json.RawMessage(`{"nested":[false,7,"preserved"]}`),
		"projectContext": private,
	}
	if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Work = work
		state.Completions = []contracts.Completion{{
			ID: "context-completion", TurnID: record.TurnID, MessageIDs: []string{message.ID},
			At: contracts.Some(float64(time.Now().UnixMilli())), Work: work,
		}}
		state.WorkTasks[0].ProjectContext = contracts.RawObject{"private": private}
		if state.WorkTasks[0].Extra == nil {
			state.WorkTasks[0].Extra = contracts.RawObject{}
		}
		state.WorkTasks[0].Extra["contextSummary"] = encode("Visible context summary")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return app
}

func assertPublicContextSnapshot(t *testing.T, snapshot contracts.WorkerSnapshot, original contracts.State) {
	t.Helper()
	if snapshot.ConversationID != original.ConversationID || len(snapshot.Messages) != 1 || len(snapshot.Completions) != 1 || len(snapshot.WorkTasks) != 1 {
		t.Fatal("public projection lost conversation or collection identities")
	}
	for _, work := range []contracts.RawObject{snapshot.Messages[0].Work, snapshot.Completions[0].Work} {
		if _, present := work["projectContext"]; present {
			t.Fatal("private nested project context reached public state")
		}
		for _, key := range []string{"id", "turnId", "contextSummary", "future"} {
			if !bytes.Equal(work[key], original.Messages[0].Work[key]) {
				t.Fatal("public projection changed unrelated nested work metadata")
			}
		}
	}
	if snapshot.WorkTasks[0].ProjectContext != nil || snapshot.WorkTasks[0].ID != original.WorkTasks[0].ID || snapshot.WorkTasks[0].TurnID != original.WorkTasks[0].TurnID || !bytes.Equal(snapshot.WorkTasks[0].Extra["contextSummary"], original.WorkTasks[0].Extra["contextSummary"]) {
		t.Fatal("top-level task projection changed identity or visible summary")
	}
	message := *snapshot.Messages[0]
	message.Work = original.Messages[0].Work
	completion := snapshot.Completions[0]
	completion.Work = original.Completions[0].Work
	task := snapshot.WorkTasks[0]
	task.ProjectContext = original.WorkTasks[0].ProjectContext
	if !reflect.DeepEqual(message, *original.Messages[0]) || !reflect.DeepEqual(completion, original.Completions[0]) || !reflect.DeepEqual(task, original.WorkTasks[0]) {
		t.Fatal("public projection changed a non-context field")
	}
}

func TestWorkerPublicStateRemovesLegacyNestedContextWithoutChangingDurableJSON(t *testing.T) {
	app := snapshotContextFixture(t)
	original := app.store.Snapshot()
	file := filepath.Join(app.options.Startup.DataDir, "state.json")
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	revision := app.store.Revision()
	for range 2 {
		response := callWorker(app, http.MethodGet, "/api/state", "")
		var snapshot contracts.WorkerSnapshot
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &snapshot) != nil {
			t.Fatal("public state could not be decoded")
		}
		assertPublicContextSnapshot(t, snapshot, original)
		if bytes.Contains(response.Body.Bytes(), []byte("private-context-fixture")) {
			t.Fatal("private context text reached public state")
		}
	}
	after, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(before, after) || app.store.Revision() != revision || !reflect.DeepEqual(app.store.Snapshot(), original) {
		t.Fatal("read-only public projection changed authoritative state")
	}
}

func TestWorkerSSEInitialAndLiveStatesUseTheSamePrivateContextProjection(t *testing.T) {
	app := snapshotContextFixture(t)
	original := app.store.Snapshot()
	app.wg.Add(1)
	go app.broadcast()
	server := httptest.NewServer(app.Handler())
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Dant-Token", app.auth.Info().Token)
	request.Host = "127.0.0.1:4317"
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal("authenticated SSE connection failed")
	}
	reader := bufio.NewReader(response.Body)
	read := func() contracts.WorkerSnapshot {
		t.Helper()
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal("SSE state did not arrive before its deadline", err)
			}
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event struct {
				Type string                   `json:"type"`
				Data contracts.WorkerSnapshot `json:"data"`
			}
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil || event.Type != "state" {
				t.Fatal("SSE state frame was invalid")
			}
			return event.Data
		}
	}
	assertPublicContextSnapshot(t, read(), original)
	previous := original
	if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Text = "Updated public message"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	original = app.store.Snapshot()
	for {
		snapshot := read()
		current := len(snapshot.Messages) == 1 && snapshot.Messages[0].Text == original.Messages[0].Text
		expected := previous
		if current {
			expected = original
		}
		assertPublicContextSnapshot(t, snapshot, expected)
		if current {
			break
		}
	}
}
