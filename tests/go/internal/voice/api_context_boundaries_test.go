package voice

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPILiveContextCommitsOnlyMatchingAcknowledgedSnapshots(t *testing.T) {
	var rejected atomic.Bool
	api, socket, _ := apiFixture(t, APIOptions{Context: func(context.Context, bool) (string, error) {
		if rejected.Load() {
			return "", errors.New("isolated reference read failure")
		}
		return "current shared reference", nil
	}})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "session.update" {
			socket.emit(object(map[string]any{"type": "session.updated", "session": objectField(event, "session")}))
		}
	}
	startAPIFixture(t, api)
	message := &contracts.ChatMessage{ID: "message", Role: contracts.RoleAssistant, Text: "first shared result"}
	if result := api.SyncContext(t.Context(), "fixture-call", "message", message); result.Status != contracts.LiveContextStatusSubmitted || result.MessageID != message.ID {
		t.Fatal("matching reference acknowledgement was not committed", result)
	}
	message.Text = "updated shared result"
	if result := api.SyncContext(t.Context(), "fixture-call", "message", message); result.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("replacement live reference was not committed", result)
	}
	api.mu.Lock()
	s := api.session
	if len(s.contextOrder) != 1 || !strings.Contains(s.contextEntries["message:message"], "updated shared result") {
		api.mu.Unlock()
		t.Fatal("same-key reference accumulated stale snapshots")
	}
	api.mu.Unlock()
	if result := api.SyncContext(t.Context(), "fixture-call", "unknown", message); result.Status != contracts.LiveContextStatusFailed {
		t.Fatal("invalid live context kind was submitted", result)
	}
	if result := api.SyncContext(t.Context(), "other-call", "message", message); result.Status != contracts.LiveContextStatusCancelled || result.ContextID == "" {
		t.Fatal("foreign call acquired a live reference", result)
	}
	if result := api.SyncMemory(t.Context(), "other-call", "memory"); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("foreign call acquired a memory snapshot", result)
	}
	rejected.Store(true)
	before := socket.count("session.update")
	if result := api.SyncMemory(t.Context(), "fixture-call", "uncommitted replacement"); result.Status != contracts.LiveContextStatusFailed || socket.count("session.update") != before {
		t.Fatal("failed current reference read crossed sideband transport", result)
	}
}

func TestAPILiveContextRejectsDetachedSessionBeforeWriting(t *testing.T) {
	api, s := conversationSessionFixture(t)
	api.options.ContextTimeout = defaultContextTimeout
	s.contextEntries = map[string]string{}
	s.ctx = t.Context()
	if err := api.sendContext(t.Context(), s, ContextInput{Key: "reference", Text: "reference", ContextID: "context"}); !errors.Is(err, ErrContextRejected) {
		t.Fatal("socket-free live context was treated as sent", err)
	}
	api.session = nil
	if err := api.sendContext(t.Context(), s, ContextInput{Key: "reference", Text: "reference", ContextID: "context"}); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("detached media generation sent a live reference", err)
	}
}
