package app

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestConversationMetadataAndHistoryRoutesDoNotExecuteOrChangeReadReceipts(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "unchanged content", ClientMessageID: "52a143de-1055-49a2-bd13-29d29dcb116e"})
	if err != nil {
		t.Fatal(err)
	}
	conversation := app.store.ConversationID()
	response := callWorker(app, http.MethodPatch, "/api/messages/"+message.ID+"/metadata", `{"conversationId":"`+conversation+`","pinned":true,"starred":true}`)
	if response.Code != http.StatusOK {
		t.Fatalf("metadata status %d", response.Code)
	}
	saved, _ := app.store.Message(message.ID)
	if saved.Read || !saved.Pinned.Value || !saved.Starred.Value || saved.Text != message.Text || saved.TurnID.Value != "" || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("bookmark changed task ownership or delivery state")
	}
	response = callWorker(app, http.MethodPatch, "/api/messages/"+message.ID+"/metadata", `{"conversationId":"old-conversation","starred":false}`)
	if response.Code != http.StatusConflict {
		t.Fatal("stale scope modified current message")
	}
	response = callWorker(app, http.MethodPatch, "/api/messages/"+message.ID+"/metadata", `{"conversationId":"`+conversation+`","starred":null}`)
	if response.Code != http.StatusBadRequest {
		t.Fatal("null metadata became false")
	}
	response = callWorker(app, http.MethodDelete, "/api/history", `{"confirm":true}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Code)
	}
	response = callWorker(app, http.MethodPost, "/api/messages", `{"text":"unchanged content","clientMessageId":"`+message.ClientMessageID+`"}`)
	if response.Code != http.StatusConflict || len(app.store.Snapshot().Messages) != 0 {
		t.Fatal("late client request restored deleted history")
	}
}

func TestNewMessageValidatesAttachmentBytesBeforeAdmissionWhileDuplicateRemainsReadOnly(t *testing.T) {
	app := fixtureWorker(t)
	file, err := app.attachments.Put(context.Background(), "fixture.txt", "text/plain", []byte("verified bytes"))
	if err != nil {
		t.Fatal(err)
	}
	message, err := app.store.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "existing input", ClientMessageID: "c33283b1-39cd-42fd-9e31-c54593ab3cab", Attachments: []contracts.Attachment{file}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file.GuestPath, []byte("modified bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := callWorker(app, http.MethodPost, "/api/messages", `{"text":"new input","clientMessageId":"2f2a5c56-856b-402d-9dba-a34d95799cb1","attachments":["`+file.ID+`"]}`)
	if response.Code != http.StatusBadRequest || len(app.store.Snapshot().Messages) != 1 {
		t.Fatal("modified attachment entered a new request")
	}
	response = callWorker(app, http.MethodPost, "/api/messages", `{"text":"existing input","clientMessageId":"`+message.ClientMessageID+`","attachments":["`+file.ID+`"]}`)
	if response.Code != http.StatusOK || len(app.store.Snapshot().Messages) != 1 || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("read-only duplicate unexpectedly retried execution or revalidated an old delivery")
	}
}

func TestWorkContextAndDismissRoutesRetainScopeConfirmationAndReadOnlyQueries(t *testing.T) {
	app := fixtureWorker(t)
	message, _ := app.store.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "original task"})
	plan, _ := workstate.PublicPlan([]contracts.PlanStep{{Step: "remaining verification", Status: contracts.PlanStepStatusPending}}, nil)
	record, err := app.store.RegisterWork(context.Background(), store.RegisterWorkOptions{TurnID: "captured-turn", MessageID: message.ID, Source: "chat", Title: "saved task", Plan: &plan})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.store.UpdateRegisteredWork(context.Background(), record.TurnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true}); err != nil {
		t.Fatal(err)
	}
	conversation := app.store.ConversationID()
	revision := app.store.Revision()
	response := callWorker(app, http.MethodGet, "/api/tasks/"+record.ID+"/context?conversationId="+conversation+"&turnId="+record.TurnID, "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "original task") || app.store.Revision() != revision || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("task context read changed state or lost original reference")
	}
	response = callWorker(app, http.MethodPost, "/api/tasks/"+record.ID+"/context", `{}`)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatal("task context accepted mutation")
	}
	response = callWorker(app, http.MethodPost, "/api/tasks/"+record.ID+"/dismiss", `{"kind":"work","expectedTurnId":"`+record.TurnID+`","expectedConversationId":"`+conversation+`"}`)
	var failure struct {
		ConfirmationRequired bool `json:"confirmationRequired"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &failure)
	if response.Code != http.StatusConflict || !failure.ConfirmationRequired {
		t.Fatal("unfinished history was hidden without confirmation")
	}
	response = callWorker(app, http.MethodPost, "/api/tasks/"+record.ID+"/dismiss", `{"kind":"work","confirmUnfinished":true,"expectedTurnId":"old-turn","expectedConversationId":"`+conversation+`"}`)
	if response.Code != http.StatusConflict {
		t.Fatal("stale inline confirmation hid a replacement turn")
	}
	response = callWorker(app, http.MethodPost, "/api/tasks/"+record.ID+"/dismiss", `{"kind":"work","confirmUnfinished":true,"expectedTurnId":"`+record.TurnID+`","expectedConversationId":"`+conversation+`"}`)
	if response.Code != http.StatusOK || app.store.Snapshot().WorkTasks[0].ProgressDismissedAt.Value == 0 {
		t.Fatal("confirmed inactive work could not be hidden")
	}
}
