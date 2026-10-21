package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type projectSnapshotBoundary struct {
	projectFailureMemory
	previous *memory.ProjectContext
	publish  func(context.Context, json.RawMessage) (*memory.ProjectContext, error)
}

func (boundary projectSnapshotBoundary) ReadProject(context.Context, string, string) (*memory.ProjectContext, error) {
	return boundary.previous, boundary.readErr
}

func (boundary projectSnapshotBoundary) WriteProject(ctx context.Context, _, _ string, data json.RawMessage) (*memory.ProjectContext, error) {
	return boundary.publish(ctx, data)
}

func TestProjectCapturePreservesAndOrdersSavedReferencesWithoutRepeatingTheirIDs(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	previous := &memory.ProjectContext{
		Version: 1, ReferenceDataOnly: true, UpdatedAt: 5000,
		HumanUpdates: []memory.ProjectEntry{
			{MessageID: "newest", At: 3000, Text: "Newest saved input", Attachments: []memory.ProjectAttachment{}},
			{MessageID: "oldest", At: 1000, Text: "Oldest saved input", Attachments: []memory.ProjectAttachment{}},
		},
		Results: []memory.ProjectEntry{
			{MessageID: "saved-result", At: 2500, Text: "Previously saved result", Attachments: []memory.ProjectAttachment{}},
		},
	}
	engine.options.DurableMemory = &projectSnapshotBoundary{previous: previous}
	for _, entry := range []struct {
		id string
		at float64
	}{{"middle", 2000}, {"same-time", 2000}} {
		if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{
			ID: entry.id, Role: contracts.RoleUser, Text: "Current scoped input",
			Time: contracts.Some(entry.at), WorkID: workID, TurnID: contracts.Some(fromTurn),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{
		ID: "saved-result", Role: contracts.RoleAssistant, Text: "Updated confirmed result",
		Time: contracts.Some(float64(2500)), WorkID: workID, TurnID: contracts.Some(fromTurn),
		Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
	}); err != nil {
		t.Fatal(err)
	}
	encoded, err := engine.TaskContext(t.Context(), workID, persistence.ConversationID(), fromTurn)
	var project memory.ProjectContext
	if err != nil || json.Unmarshal(encoded, &project) != nil || len(project.HumanUpdates) != 4 || len(project.Results) != 1 || project.Results[0].Text != "Updated confirmed result" {
		t.Fatal("project refresh duplicated or lost a previously saved reference", err)
	}
	for index, id := range []string{"oldest", "middle", "same-time", "newest"} {
		if project.HumanUpdates[index].MessageID != id {
			t.Fatal("project references lost their stable chronological order")
		}
	}
	if previous.Results[0].Text != "Previously saved result" || previous.HumanUpdates[0].MessageID != "newest" {
		t.Fatal("project capture mutated the saved memory provider snapshot")
	}
	assertWorkerQuiet(t, worker)
}

func TestProjectPublicationRechecksConversationAndTurnAfterDurableMemoryWrite(t *testing.T) {
	for _, scenario := range []string{"changed conversation", "changed turn", "invalid memory response"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			workID, fromTurn := savedUnfinished(t, persistence)
			state := persistence.Snapshot()
			record, err := store.FindWork(&state, workID)
			if err != nil {
				t.Fatal(err)
			}
			writes := 0
			engine.options.DurableMemory = &projectSnapshotBoundary{publish: func(ctx context.Context, data json.RawMessage) (*memory.ProjectContext, error) {
				writes++
				if scenario == "invalid memory response" {
					return nil, nil
				}
				if err := persistence.Mutate(ctx, func(current *contracts.State) error {
					if scenario == "changed conversation" {
						current.ConversationID = store.UUID()
					} else {
						current.WorkTasks[0].TurnID = "replacement-project-turn"
						current.WorkTasks[0].TurnIDs = append(current.WorkTasks[0].TurnIDs, "replacement-project-turn")
					}
					return nil
				}); err != nil {
					return nil, err
				}
				return memory.SafeProjectContext(data)
			}}
			engine.mu.Lock()
			err = engine.refreshProjectLocked(t.Context(), record, nil)
			engine.mu.Unlock()
			if err == nil || scenario != "invalid memory response" && !errors.Is(err, ErrStaleOwner) || writes != 1 {
				t.Fatal("late project publication modified a replacement owner", err)
			}
			current := persistence.Snapshot()
			if current.WorkTasks[0].ProjectContext != nil || record.ProjectContext != nil || current.WorkTasks[0].ID != workID || scenario != "changed turn" && current.WorkTasks[0].TurnID != fromTurn {
				t.Fatal("rejected project publication changed the authoritative task references")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestInvalidProjectReferencesAreOmittedAndReadFailuresRemainVisible(t *testing.T) {
	identity := func(text string) string { return text }
	for _, message := range []*contracts.ChatMessage{
		nil,
		{ID: "", Time: contracts.Some(float64(1000))},
		{ID: "missing-time"},
		{
			ID: "invalid-legacy-text", Text: "Recognized text", Time: contracts.Some(float64(1000)),
			LegacyText: contracts.LegacyJSON{
				Decoded:  map[string]string{"text": "Recognized text"},
				Original: map[string]json.RawMessage{"text": json.RawMessage(`{"not":"text"}`)},
			},
		},
	} {
		if encoded := projectEntry(message, identity); string(encoded) != "null" {
			t.Fatal("malformed retained project reference was admitted as usable content")
		}
	}
	engine, persistence, worker := engineFixture(t)
	workID, fromTurn := savedUnfinished(t, persistence)
	failure := errors.New("isolated_project_read_failure")
	engine.options.DurableMemory = &projectSnapshotBoundary{projectFailureMemory: projectFailureMemory{readErr: failure}}
	before := persistence.Revision()
	if _, err := engine.TaskContext(t.Context(), workID, persistence.ConversationID(), fromTurn); !errors.Is(err, failure) || persistence.Revision() != before {
		t.Fatal("read-only project failure invented an empty successful context", err)
	}
	assertWorkerQuiet(t, worker)
}
