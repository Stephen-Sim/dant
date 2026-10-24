package telegram_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
)

type idleBackupHTTP struct{ calls atomic.Int32 }

func (client *idleBackupHTTP) Do(*http.Request) (*http.Response, error) {
	client.calls.Add(1)
	return nil, errors.New("unexpected synthetic transport")
}

func TestAgentDataBackupRemainsConsistentAcrossIdleTelegramFlush(t *testing.T) {
	for _, changed := range []bool{false, true} {
		name := "unchanged"
		if changed {
			name = "real-change"
		}
		t.Run(name, func(t *testing.T) { agentDataIdleFlush(t, changed) })
	}
}

func agentDataIdleFlush(t *testing.T, changed bool) {
	t.Helper()
	data, workspace := t.TempDir(), t.TempDir()
	persistence, err := store.Open(data, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	attachments, err := files.OpenAttachmentStore(filepath.Join(data, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	token := "123456:fixture_token_is_not_a_real_secret"
	configuration := telegram.Config{
		Version: 1, DeliveryVersion: 2, ForwardMode: telegram.ForwardUnread,
		CombineReplies: true, Enabled: true, Token: &token,
		Bot: &telegram.Bot{ID: "11", Username: "fixture_bot"},
		Owner: &telegram.Owner{ChatID: "21", UserID: "31", PairingID: "fixture-pairing",
			SyncVersion: 1, ConversationID: persistence.ConversationID()},
		Outbox: []*telegram.OutboxItem{}, Receipts: []telegram.Receipt{}, ResultKeys: []string{},
	}
	raw, err := json.Marshal(configuration)
	if err != nil || os.WriteFile(filepath.Join(data, "telegram.json"), raw, 0o600) != nil {
		t.Fatal("synthetic configuration could not be created", err)
	}
	client := &idleBackupHTTP{}
	gateway, err := telegram.Open(t.Context(), data, telegram.Options{
		Store: persistence, Attachments: attachments, HTTP: client,
		Admit: func(context.Context, string, *contracts.ChatMessage) error {
			t.Fatal("idle backup admitted a task")
			return nil
		},
		WorkSnapshot: func() telegram.WorkState { return telegram.WorkState{Online: true} },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(t.Context())
	status := gateway.Status()
	for _, key := range []string{"enabled", "configured", "paired"} {
		var enabled bool
		if json.Unmarshal(status[key], &enabled) != nil || !enabled {
			t.Fatal("backup fixture did not exercise an enabled, configured, paired gateway")
		}
	}
	checks := 0
	backup, err := backups.CreateWorkerBackup(t.Context(), backups.WorkerBackupOptions{
		DataDir: data, WorkspaceRoot: workspace, TemporaryRoot: t.TempDir(),
		SourceID: strings.Repeat("a", 64), AppVersion: "0.4.11",
		ValidateCurrent: func(ctx context.Context) error {
			checks++
			if checks == 2 {
				// This runs after capture observed/copied its sources, exactly
				// when a maintenance-triggered idle flush used to replace them.
				_, err := gateway.Flush(ctx)
				if err == nil && changed {
					combine := false
					_, err = gateway.Configure(ctx, telegram.ConfigureInput{CombineReplies: &combine})
				}
				return err
			}
			return ctx.Err()
		},
	})
	if changed {
		if !errors.Is(err, backups.ErrSourceChanged) || backup != nil || checks != 2 || client.calls.Load() != 0 {
			t.Fatal("a real configuration mutation bypassed backup source-change protection", err)
		}
		return
	}
	if err != nil {
		t.Fatal("an idle gateway invalidated a consistent agent-data capture", err)
	}
	defer backup.Close()
	if checks != 2 || client.calls.Load() != 0 || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("isolated backup did not retain its idle/no-external-action boundary")
	}
	if err := backups.ValidateWorkerBackup(t.Context(), backup.Archive); err != nil {
		t.Fatal("captured agent data did not remain valid", err)
	}
}
