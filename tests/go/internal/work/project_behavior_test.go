package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestTaskContextContainsBoundedOwnedReferencesWithoutChangingStoredHistory(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	attachment := deliveryBehaviorFiles(t, 1)[0]
	originalText := strings.Repeat("x", projectTextCharacters-1) + "😀"
	original, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: originalText, Time: contracts.Some(float64(1000)), TurnID: contracts.Some("project-source-turn"),
		Attachments: []contracts.Attachment{attachment, {ID: "untrusted-file", Name: "not an owned attachment"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "project-source-turn", MessageID: original.ID, Source: "chat", Title: "project context", Observed: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for index := range 10 {
		for _, role := range []contracts.Role{contracts.RoleUser, contracts.RoleAssistant} {
			_, err := persistence.Add(context.Background(), &contracts.ChatMessage{
				Role: role, Text: fmt.Sprintf("%s update %d", role, index), Time: contracts.Some(float64(2000 + index)),
				TurnID: contracts.Some(record.TurnID), WorkID: record.ID, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
			})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, input := range []*contracts.ChatMessage{
		{Role: contracts.RoleUser, Text: "foreign work must remain outside", WorkID: "foreign-work", TurnID: contracts.Some(record.TurnID)},
		{Role: contracts.RoleAssistant, Text: "streaming output is not a result", WorkID: record.ID, Status: contracts.Some(contracts.MessageStatusStreaming)},
		{Role: contracts.RoleUser, Text: "foreign turn must remain outside", WorkID: record.ID, TurnID: contracts.Some("foreign-turn")},
	} {
		if _, err := persistence.Add(context.Background(), input); err != nil {
			t.Fatal(err)
		}
	}
	before := raw(persistence.Snapshot())
	encoded, err := engine.TaskContext(context.Background(), record.ID, persistence.ConversationID(), record.TurnID)
	var project memory.ProjectContext
	if err != nil || json.Unmarshal(encoded, &project) != nil || project.OriginalRequest == nil || project.OriginalRequest.MessageID != original.ID || len(project.HumanUpdates) != 8 || len(project.Results) != 8 {
		t.Fatal("task context lost the original request or its bounded owned references", err)
	}
	if strings.Contains(string(encoded), "foreign") || strings.Contains(string(encoded), "streaming output") || len(project.OriginalRequest.Attachments) != 1 || project.OriginalRequest.Attachments[0].ID != attachment.ID {
		t.Fatal("task context included an incompatible message or unvalidated attachment identity")
	}
	var envelope struct {
		ReferenceDataOnly bool `json:"referenceDataOnly"`
		OriginalRequest   struct {
			Text json.RawMessage `json:"text"`
		} `json:"originalRequest"`
	}
	if json.Unmarshal(encoded, &envelope) != nil {
		t.Fatal("context is not a valid reference envelope")
	}
	units, err := contracts.DecodeJSONTextUnits(envelope.OriginalRequest.Text)
	if err != nil || !envelope.ReferenceDataOnly || len(units) != projectTextCharacters || units[len(units)-1] != 0xd83d {
		t.Fatal("bounded context changed the precise UTF16 slice or lost its authority boundary", err)
	}
	if string(raw(persistence.Snapshot())) != string(before) {
		t.Fatal("a read-only task context request mutated the authoritative history")
	}
	for _, scope := range []struct{ work, conversation, turn string }{
		{record.ID, "another-conversation", record.TurnID},
		{record.ID, persistence.ConversationID(), "another-turn"},
		{"missing-work", persistence.ConversationID(), record.TurnID},
	} {
		if _, err := engine.TaskContext(context.Background(), scope.work, scope.conversation, scope.turn); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("task references crossed an exact ownership boundary", err)
		}
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.TaskContext(cancelled, record.ID, persistence.ConversationID(), record.TurnID); !errors.Is(err, ErrClosed) {
		t.Fatal("cancelled context lookup continued reading saved data", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestPersistedProjectContextAndPublicSnapshotsKeepTheirDistinctResponsibilities(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	durable, err := memory.OpenStore(context.Background(), t.TempDir(), memory.StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = durable.Close() })
	engine.options.DurableMemory = durable
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "persistent-project-turn")
	if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("persisted project", contracts.PlanStepStatusPending), owner); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	record := state.WorkTasks[0]
	project, err := durable.ReadProject(context.Background(), state.ConversationID, record.ID)
	if err != nil || project == nil || project.OriginalRequest == nil || project.OriginalRequest.MessageID != message.ID {
		t.Fatal("registering a plan did not preserve its original request in durable project memory", err)
	}
	public := TaskContextSnapshots(state.WorkTasks)
	if len(public) != 1 || public[0].ProjectContext != nil || public[0].ID != record.ID || public[0].Title != record.Title || state.WorkTasks[0].ProjectContext == nil {
		t.Fatal("public work snapshots leaked full references or mutated their owning records")
	}
	encoded, err := engine.TaskContext(context.Background(), record.ID, state.ConversationID, record.TurnID)
	if err != nil || !strings.Contains(string(encoded), message.ID) {
		t.Fatal("explicit context retrieval lost the durable reference", err)
	}
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		current, err := store.FindWork(state, record.ID)
		if err != nil {
			return err
		}
		current.ProgressDismissedAt = contracts.Some(engine.Timestamp())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.TaskContext(context.Background(), record.ID, state.ConversationID, record.TurnID); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("dismissed progress still exposed its explicit context", err)
	}
}

type projectFailureMemory struct {
	readErr, writeErr error
}

func (*projectFailureMemory) Context(context.Context, bool) (string, error) { return "", nil }
func (*projectFailureMemory) Directory() string                             { return "" }

func (fixture *projectFailureMemory) ReadProject(context.Context, string, string) (*memory.ProjectContext, error) {
	return nil, fixture.readErr
}

func (fixture *projectFailureMemory) WriteProject(context.Context, string, string, json.RawMessage) (*memory.ProjectContext, error) {
	return nil, fixture.writeErr
}

func TestProjectStorageFailuresAreReportedWithoutCreatingAReferenceOrExecutingAnotherTurn(t *testing.T) {
	for _, failWrite := range []bool{false, true} {
		t.Run(map[bool]string{false: "read", true: "write"}[failWrite], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			failure := errors.New("isolated_project_failure")
			storage := &projectFailureMemory{readErr: failure}
			if failWrite {
				storage.readErr, storage.writeErr = nil, failure
			}
			engine.options.DurableMemory = storage
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "failed-project-turn")
			if _, err := engine.Tool(context.Background(), "task_plan", behaviorPlan("project failure", contracts.PlanStepStatusPending), owner); !errors.Is(err, failure) {
				t.Fatal("unconfirmed project persistence claimed a successful plan", err)
			}
			state := persistence.Snapshot()
			if len(state.WorkTasks) != 1 || state.WorkTasks[0].ProjectContext != nil || !owner.IsCurrent() {
				t.Fatal("project failure invented context or retired an unrelated acknowledged owner")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestProjectAttachmentSizeReferencesUseTheUploadContractWithoutInventingInvalidValues(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	attachments := make([]contracts.Attachment, 5)
	for index, size := range []float64{0, 10 * 1024 * 1024, 10*1024*1024 + 1, -1, 1.5} {
		attachments[index] = contracts.Attachment{ID: store.UUID(), Name: "bounded fixture", Type: "application/octet-stream", Size: contracts.Some(size)}
	}
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "inspect metadata only", Attachments: attachments})
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{
		TurnID: "attachment-size-contract-turn", MessageID: message.ID, Source: "chat", Title: "metadata reference", Observed: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := engine.TaskContext(t.Context(), record.ID, persistence.ConversationID(), record.TurnID)
	var reference struct {
		OriginalRequest struct{ Attachments []contracts.RawObject }
	}
	if err != nil || json.Unmarshal(encoded, &reference) != nil || len(reference.OriginalRequest.Attachments) != len(attachments) {
		t.Fatal("project reference lost supported attachment identities", err)
	}
	for index, file := range reference.OriginalRequest.Attachments {
		size, present := file["size"]
		if present != (index < 2) || index == 0 && string(size) != "0" || index == 1 && string(size) != "10485760" {
			t.Fatal("reference metadata invented a size outside the actual attachment contract")
		}
	}
	assertWorkerQuiet(t, worker)
}
