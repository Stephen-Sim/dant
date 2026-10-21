package history

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestNotificationStoreRejectsInvalidFilesAndKeepsCommittedStateOnSaveFailure(t *testing.T) {
	if _, err := OpenNotificationHub(t.TempDir(), NotificationOptions{Grace: -1}); !errors.Is(err, ErrNotificationState) {
		t.Fatal("negative notification grace accepted", err)
	}
	for _, raw := range []string{"{", "[]", "null"} {
		directory := t.TempDir()
		if err := os.WriteFile(filepath.Join(directory, "notifications.json"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenNotificationHub(directory, NotificationOptions{}); !errors.Is(err, ErrNotificationState) {
			t.Fatal("invalid disk notification state was accepted", err)
		}
	}
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "notifications.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenNotificationHub(directory, NotificationOptions{}); !errors.Is(err, ErrNotificationState) {
		t.Fatal("directory was read as notification data", err)
	}
	hub, err := OpenNotificationHub(t.TempDir(), NotificationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.Configure(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := hub.Configure(cancelled, true); !errors.Is(err, ErrNotificationSave) || hub.state.Enabled {
		t.Fatal("failed write replaced committed notification state", err)
	}
	if err := hub.Acknowledge(t.Context(), "missing"); !errors.Is(err, ErrNotificationState) {
		t.Fatal("missing banner acknowledgement was invented", err)
	}
	next := cloneNotificationState(hub.state)
	next.Records["invalid"] = notificationRecord{ID: "invalid", At: math.NaN()}
	if err := hub.save(t.Context(), next); !errors.Is(err, ErrNotificationSave) || len(hub.state.Records) != 0 {
		t.Fatal("unencodable notification state was committed", err)
	}
}

func TestNotificationReadFilteringRetentionAndDuplicateAcknowledgement(t *testing.T) {
	clock := time.UnixMilli(10000)
	directory := t.TempDir()
	fixture := `{"enabled":true,"enabledAt":10000,"records":{"bad":{"id":"other","at":1,"observedAt":1},"bad-time":{"id":"bad-time","at":-1,"observedAt":1},"bad-json":null}}`
	if err := os.WriteFile(filepath.Join(directory, "notifications.json"), []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	hub, err := OpenNotificationHub(directory, NotificationOptions{Now: func() time.Time { return clock }})
	if err != nil || len(hub.state.Records) != 0 {
		t.Fatal("invalid persisted notification records were retained", err)
	}
	for index := range MaxNotificationRecords + 1 {
		id := fmt.Sprintf("old-%04d", index)
		hub.state.Records[id] = notificationRecord{ID: id, At: float64(index / 2), ObservedAt: 1}
	}
	snapshot := contracts.WorkerSnapshot{ConversationID: "current", Messages: []*contracts.ChatMessage{nil, {ID: "read", Role: contracts.RoleAssistant, Text: "visible", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), Receipt: contracts.RawObject{"readAt": json.RawMessage("10001")}}}, Completions: []contracts.Completion{{}, {ID: "no-time"}, {ID: "read-completion", At: contracts.Some(float64(10000)), MessageIDs: []string{"read"}}, {ID: "pending", At: contracts.Some(float64(10000))}}}
	if err := hub.Observe(t.Context(), snapshot); err != nil || len(hub.state.Records) != MaxNotificationRecords {
		t.Fatal("bounded notification retention failed", len(hub.state.Records), err)
	}
	clock = clock.Add(NotificationGrace)
	pending := hub.Pending()
	if len(pending) != 1 || pending[0].ID != "pending" || pending[0].ConversationID == nil || *pending[0].ConversationID != "current" || pending[0].MessageID != nil {
		t.Fatal("read acknowledgement or optional identity filtering changed", pending)
	}
	if err := hub.Acknowledge(t.Context(), "pending"); err != nil {
		t.Fatal(err)
	}
	if err := hub.Acknowledge(t.Context(), "pending"); err != nil || len(hub.Pending()) != 0 {
		t.Fatal("duplicate acknowledgement redelivered a banner", err)
	}
	if err := hub.Observe(t.Context(), snapshot); err != nil {
		t.Fatal("unchanged snapshot failed", err)
	}
}

func TestNotificationAttachmentPreviewRejectsForeignAndNonfinalMessages(t *testing.T) {
	completion := contracts.Completion{MessageIDs: []string{"missing", "user", "streaming", "foreign", "files"}}
	messages := map[string]*contracts.ChatMessage{
		"user":      {Role: contracts.RoleUser, Text: "must not notify", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))},
		"streaming": {Role: contracts.RoleAssistant, Text: "not final", Status: contracts.Some(contracts.MessageStatusStreaming)},
		"foreign":   {Role: contracts.RoleAssistant, Text: "other conversation", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), Source: contracts.RawObject{"conversationId": json.RawMessage(`"other"`)}},
		"files":     {Role: contracts.RoleAssistant, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), Attachments: []contracts.Attachment{{Name: "folder\\report.txt"}, {Name: "image.png"}}},
	}
	if preview := completionPreview(completion, messages, "current"); preview != "report.txt · image.png" {
		t.Fatal("safe delivered attachment names did not form preview", preview)
	}
	delete(messages, "files")
	if preview := completionPreview(completion, messages, "current"); preview != "" {
		t.Fatal("foreign or nonfinal message appeared in notification", preview)
	}
}
