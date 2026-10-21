package app

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestWorkerMemoryProjectionFailureKeepsTheAuthoritativeSQLiteCommit(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var fail atomic.Bool
	options.StoreOptions.Write = func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
		if fail.Load() {
			return errors.New("synthetic projection storage failure")
		}
		return files.WriteAtomic(ctx, path, data, mode)
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	before := app.store.Snapshot().Memory
	fail.Store(true)
	result, err := app.saveNote(t.Context(), "working-memory.md", "Authoritative SQLite note")
	if err != nil || !strings.Contains(string(result), `"saved":true`) {
		t.Fatal("committed SQLite note was reported as unsaved", err)
	}
	note, err := app.memory.ReadNote(t.Context(), "working-memory.md")
	if err != nil || note != "Authoritative SQLite note" || app.store.Snapshot().Memory != before {
		t.Fatal("failed legacy projection replaced or lost authoritative memory", err)
	}
	fail.Store(false)
	app.Close()
	records, err := app.diagnostics.Recent(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		if record.Code == "MEMORY_PROJECTION_FAILED" {
			found = true
		}
	}
	if !found {
		t.Fatal("projection uncertainty had no bounded diagnostic receipt")
	}
}

func TestWorkerCallDeliveryRejectsChangedClientAndMediaIdentityWithoutReplaying(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "original", ClientMessageID: "original-client"})
	if err != nil {
		t.Fatal(err)
	}
	copy := *message
	copy.ClientMessageID = "replacement-client"
	if err := app.sendAcceptedCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{Message: &copy, CallID: "captured-call"}); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("changed durable client identity was accepted", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := app.saveNote(cancelled, "working-memory.md", "must not commit"); err == nil {
		t.Fatal("cancelled credential inspection allowed a memory write")
	}

	app, socket, callID, _ := activeAPICallFixture(t)
	message, err = app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "captured input", ClientMessageID: "captured-client"})
	if err != nil {
		t.Fatal(err)
	}
	socket.mu.Lock()
	socket.beforeAck = func() {
		if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
			for _, current := range state.Messages {
				if current.ID == message.ID {
					current.VoiceCallID = "replacement-call"
				}
			}
			return nil
		}); err != nil {
			t.Error(err)
		}
	}
	socket.mu.Unlock()
	if err := app.sendAcceptedCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{Message: message, CallID: callID}); err == nil {
		t.Fatal("late acknowledgement overwrote replacement media ownership")
	}
	saved, err := app.store.Message(message.ID)
	if err != nil || saved.VoiceCallID != "replacement-call" || socket.count("conversation.item.create") != 1 {
		t.Fatal("stale delivery replayed or corrupted the new media identity", err)
	}
}
