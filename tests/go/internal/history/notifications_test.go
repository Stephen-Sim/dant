package history

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestNotificationGraceReadReceiptsAndDeliverySurviveRestart(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	clock := time.UnixMilli(10000)
	options := NotificationOptions{Now: func() time.Time { return clock }}
	hub, err := OpenNotificationHub(directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if err = hub.Configure(ctx, true); err != nil {
		t.Fatal(err)
	}
	message := &contracts.ChatMessage{ID: "reply", Role: contracts.RoleAssistant, Text: "**Verified** [result](https://example.test/result)", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}
	snapshot := contracts.WorkerSnapshot{ConversationID: "conversation", Messages: []*contracts.ChatMessage{message}, Completions: []contracts.Completion{{ID: "completion", At: contracts.Some(10000.0), MessageIDs: []string{"reply"}}}}
	if err = hub.Observe(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if len(hub.Pending()) != 0 {
		t.Fatal("notification skipped read grace period")
	}
	clock = clock.Add(NotificationGrace)
	pending := hub.Pending()
	if len(pending) != 1 || pending[0].Body != "Verified result" {
		t.Fatal("notification preview changed or delivery missing")
	}
	if err = hub.Acknowledge(ctx, "completion"); err != nil {
		t.Fatal(err)
	}
	restored, err := OpenNotificationHub(directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Pending()) != 0 {
		t.Fatal("acknowledged banner delivered again after restart")
	}
	raw, err := os.ReadFile(filepath.Join(directory, "notifications.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "Verified") || strings.Contains(string(raw), "example.test") {
		t.Fatal("notification persistence copied user content")
	}

	message.Read = true
	snapshot.Completions = []contracts.Completion{{ID: "read-completion", At: contracts.Some(13000.0), MessageIDs: []string{"reply"}}}
	if err = hub.Observe(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(NotificationGrace)
	if len(hub.Pending()) != 0 {
		t.Fatal("read desktop chat generated another banner")
	}
}

func TestEnablingNotificationsDoesNotReplayHistoricalCompletion(t *testing.T) {
	ctx := context.Background()
	clock := time.UnixMilli(10000)
	hub, err := OpenNotificationHub(t.TempDir(), NotificationOptions{Now: func() time.Time { return clock }})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := contracts.WorkerSnapshot{ConversationID: "new", Messages: []*contracts.ChatMessage{{ID: "old-message", Role: contracts.RoleAssistant, Text: "old", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}, Completions: []contracts.Completion{{ID: "historical", At: contracts.Some(5000.0), MessageIDs: []string{"old-message"}}}}
	if err = hub.Observe(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if err = hub.Configure(ctx, true); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Minute)
	if err = hub.Observe(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if len(hub.Pending()) != 0 {
		t.Fatal("historical completion replayed on enabling banners")
	}
}
