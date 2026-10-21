package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestWorkerVisibleReceiptPersistenceFailureKeepsOriginalUnreadState(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var armed atomic.Bool
	options.StoreOptions.Write = func(ctx context.Context, name string, raw []byte, mode fs.FileMode) error {
		if armed.Load() {
			return errors.New("isolated private receipt write failure")
		}
		return files.WriteAtomic(ctx, name, raw, mode)
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "preserved unread reply"})
	if err != nil {
		t.Fatal(err)
	}
	before := app.store.Revision()
	armed.Store(true)
	response := callWorker(app, http.MethodPost, "/api/read", string(encode(contracts.RawObject{
		"ids": encode([]string{message.ID}), "conversationId": encode(app.store.ConversationID()),
	})))
	armed.Store(false)
	if response.Code < http.StatusInternalServerError || strings.Contains(response.Body.String(), "private receipt") {
		t.Fatal("receipt failure was reported successful or exposed private storage details")
	}
	saved, err := app.store.Message(message.ID)
	if err != nil || saved.Read || app.store.Revision() != before {
		t.Fatal("failed visible receipt partially committed a read state", err)
	}
}

func TestWorkerTaskContextReadRejectsAnUnknownTurnWithoutChangingHistory(t *testing.T) {
	app := fixtureWorker(t)
	before := app.store.Revision()
	response := callWorker(app, http.MethodGet, "/api/tasks/missing-work/context?conversationId="+app.store.ConversationID()+"&turnId=retired-turn", "")
	if response.Code < http.StatusBadRequest || app.store.Revision() != before || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("unavailable task context invented work or changed conversation history")
	}
}

func TestWorkerCallAcknowledgementCannotWriteIntoAReplacementConversation(t *testing.T) {
	app, socket, callID, _ := activeAPICallFixture(t)
	conversation := app.store.ConversationID()
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "old conversation input", ClientMessageID: "old-conversation-input"})
	if err != nil {
		t.Fatal(err)
	}
	replacement := store.UUID()
	socket.mu.Lock()
	socket.beforeAck = func() {
		if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
			state.ConversationID = replacement
			state.Messages = []*contracts.ChatMessage{}
			return nil
		}); err != nil {
			t.Error(err)
		}
	}
	socket.mu.Unlock()
	err = app.sendAcceptedCallMessage(t.Context(), conversation, work.AdmissionReceipt{Message: message, CallID: callID})
	var operation *workerRuntime.OperationError
	if !errors.As(err, &operation) || !operation.UnknownOutcome {
		t.Fatal("late call acknowledgement invented a committed result in the replacement chat", err)
	}
	state := app.store.Snapshot()
	if state.ConversationID != replacement || len(state.Messages) != 0 || socket.count("conversation.item.create") != 1 {
		raw, _ := json.Marshal(struct {
			Messages int `json:"messages"`
			Writes   int `json:"writes"`
		}{len(state.Messages), socket.count("conversation.item.create")})
		t.Fatal("stale delivery wrote into or replayed across the replacement conversation", string(raw))
	}
}
