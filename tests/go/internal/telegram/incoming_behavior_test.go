package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestIncomingUpdatesRequireExactPrivateHumanOwnerAndDurablyAdvanceIgnoredOffsets(t *testing.T) {
	for _, scenario := range []string{"group", "bot", "foreign-chat", "foreign-user", "string-id", "absent-message", "disabled", "missing-bot"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			update := behaviorUpdate(t, 100, "isolated incoming request")
			switch scenario {
			case "group":
				update.Message.Chat.Type = "group"
			case "bot":
				update.Message.From.Bot = true
			case "foreign-chat":
				update.Message.Chat.ID = raw(22)
			case "foreign-user":
				update.Message.From.ID = raw(32)
			case "string-id":
				update.Message.From.ID = raw("31")
			case "absent-message":
				update.Message = nil
			case "disabled":
				fixture.Gateway.config.Enabled = false
			case "missing-bot":
				fixture.Gateway.config.Bot = nil
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			if fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 0 || len(fixture.Store.Snapshot().Messages) != 0 || len(fixture.Gateway.config.Receipts) != 0 {
				t.Fatal("untrusted update crossed admission or produced an acknowledgement")
			}
			if scenario != "disabled" && scenario != "missing-bot" && fixture.Gateway.config.Offset != 101 {
				t.Fatal("ignored update did not advance its durable polling offset")
			}
		})
	}
}

func TestIncomingAttachmentsSelectOneSafePhotoAndPreserveDocumentVoiceBytes(t *testing.T) {
	for _, kind := range []string{"photo", "document", "voice"} {
		t.Run(kind, func(t *testing.T) {
			fixture := fixture(t)
			content := []byte("isolated attachment bytes\n")
			if kind == "photo" {
				content = []byte{137, 80, 78, 71, 13, 10, 26, 10, 0}
			}
			update := behaviorUpdate(t, 100, "")
			expectedFile := kind + "-file"
			file := File{ID: expectedFile, Size: number(int64(len(content)))}
			switch kind {
			case "photo":
				update.Message.Photo = []File{
					{ID: "oversized-file", Size: number(files.MaxAttachmentBytes + 1)},
					{ID: "small-file", Size: number(1)}, file,
				}
			case "document":
				file.Name = "isolated.txt"
				update.Message.Document = &file
			case "voice":
				content = []byte("OggS\x00isolated audio fixture")
				file.Size = number(int64(len(content)))
				update.Message.Voice = &file
			}
			calls := 0
			fixture.Send = func(request *http.Request) (*http.Response, error) {
				calls++
				if strings.HasSuffix(request.URL.Path, "/getFile") {
					fixture.mu.Lock()
					body := fixture.Bodies[len(fixture.Bodies)-1]
					fixture.mu.Unlock()
					if field(body, "file_id") != expectedFile {
						t.Error("incoming photo selected a larger unsafe or lower-quality variant")
					}
					return reply(200, string(raw(map[string]any{"ok": true, "result": map[string]any{"file_path": "documents/isolated.bin", "file_size": len(content)}}))), nil
				}
				if request.Method != http.MethodGet || request.URL.Host != "api.telegram.org" || !strings.Contains(request.URL.Path, "/file/bot") {
					t.Error("attachment download left its fixed authenticated transport")
				}
				return reply(200, string(content)), nil
			}
			fixture.Admit = func(ctx context.Context, conversation string, message *contracts.ChatMessage) error {
				if conversation != fixture.Store.ConversationID() || len(message.Attachments) != 1 || field(message.Source, "pairingId") != "fixture-pairing" || field(message.Source, "messageId") != "100" {
					t.Error("attachment admission lost its exact conversation or source identity")
				}
				_, saved, err := fixture.Gateway.options.Attachments.Read(ctx, message.Attachments[0].ID)
				if err != nil || !bytes.Equal(saved, content) {
					t.Error("received attachment bytes changed before admission")
				}
				return nil
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			state := fixture.Store.Snapshot()
			if calls != 2 || fixture.Admitted.Load() != 1 || len(state.Messages) != 1 || len(state.Messages[0].Attachments) != 1 || state.Messages[0].ClientMessageID != "tg:11:100" || fixture.Gateway.config.Receipts[0].Status != ReceiptDone {
				t.Fatal("attachment intake did not produce one durable admitted message")
			}
			if kind != "voice" && state.Messages[0].Text != fixture.Gateway.word("attachmentPrompt") || kind == "voice" && state.Messages[0].Text != "" {
				t.Fatal("attachment-only text changed the voice versus document contract")
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil || calls != 2 || fixture.Admitted.Load() != 1 {
				t.Fatal("duplicate attachment update downloaded or admitted twice")
			}
		})
	}
}

func TestIncomingFailuresPersistOneReceiptAndNeverRetryDownloadsOrAdmission(t *testing.T) {
	for _, scenario := range []string{"empty", "long", "deleted", "queue-full", "oversized-photo", "bad-file-id", "declared-large", "remote-large", "bad-remote-size", "download-status", "download-network", "download-large", "admission"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			update := behaviorUpdate(t, 100, "isolated intake")
			update.Message.Document = &File{ID: "isolated-file", Name: "isolated.txt", Size: number(1)}
			switch scenario {
			case "empty":
				update.Message.Text, update.Message.Document = " \t ", nil
			case "long":
				update.Message.Text = strings.Repeat("x", 100001)
			case "deleted":
				if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
					state.DeletedClientMessageIDs = []string{"tg:11:100"}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			case "queue-full":
				fixture.Gateway.options.WorkSnapshot = func() WorkState { return WorkState{Online: true, Queue: make([]string, 32)} }
			case "oversized-photo":
				update.Message.Document = nil
				update.Message.Photo = []File{{ID: "large", Size: number(files.MaxAttachmentBytes + 1)}}
			case "bad-file-id":
				update.Message.Document.ID = ""
			case "declared-large":
				update.Message.Document.Size = number(files.MaxAttachmentBytes + 1)
			case "admission":
				fixture.Admit = func(context.Context, string, *contracts.ChatMessage) error {
					return errors.New("isolated admission rejection")
				}
			}
			fixture.Send = func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/getFile") {
					size := any(1)
					if scenario == "remote-large" {
						size = files.MaxAttachmentBytes + 1
					} else if scenario == "bad-remote-size" {
						size = "1"
					}
					return reply(200, string(raw(map[string]any{"ok": true, "result": map[string]any{"file_path": "documents/isolated.txt", "file_size": size}}))), nil
				}
				if scenario == "download-status" {
					return reply(404, "private response must not escape"), nil
				}
				if scenario == "download-network" {
					return nil, errors.New("private network detail " + fixtureToken)
				}
				response := reply(200, "x")
				if scenario == "download-large" {
					response.ContentLength = files.MaxAttachmentBytes + 1
				}
				return response, nil
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal(err)
			}
			attempts := fixture.Sent.Load()
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil || attempts != fixture.Sent.Load() {
				t.Fatal("failed or empty update was replayed")
			}
			if scenario != "admission" && fixture.Admitted.Load() != 0 {
				t.Fatal("invalid attachment or backpressure crossed admission")
			}
			if scenario != "empty" && fixture.Gateway.config.Receipts[0].Status != ReceiptFailed {
				t.Fatal("failed intake lost its durable failure receipt")
			}
			if bytes.Contains(raw(fixture.Gateway.Status()), []byte(fixtureToken)) || bytes.Contains(raw(fixture.Store.Snapshot()), []byte("private network detail")) {
				t.Fatal("intake failure exposed private transport material")
			}
		})
	}
}

func TestPollingOrdersValidatedUpdatesAndDoesNotReplayEarlierOffsets(t *testing.T) {
	fixture := fixture(t)
	updates := []json.RawMessage{raw(behaviorUpdate(t, 102, "third")), []byte(`{"update_id":"bad"}`), raw(behaviorUpdate(t, 100, "first")), raw(behaviorUpdate(t, 101, "second"))}
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/getUpdates") {
			t.Error("polling performed an unrelated request")
		}
		return reply(200, string(raw(map[string]any{"ok": true, "result": updates}))), nil
	}
	if err := fixture.Gateway.PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	state := fixture.Store.Snapshot()
	texts := []string{}
	for _, message := range state.Messages {
		texts = append(texts, message.Text)
	}
	if !slices.Equal(texts, []string{"first", "second", "third"}) || fixture.Gateway.config.Offset != 103 || fixture.Admitted.Load() != 3 {
		t.Fatal("polling reordered accepted updates or lost the persisted offset")
	}
	if err := fixture.Gateway.PollOnce(t.Context()); err != nil || fixture.Admitted.Load() != 3 {
		t.Fatal("polling replayed updates before its persisted offset")
	}
	for _, invalid := range []any{nil, map[string]any{}, make([]any, 101)} {
		fixture.Send = func(*http.Request) (*http.Response, error) {
			return reply(200, string(raw(map[string]any{"ok": true, "result": invalid}))), nil
		}
		if !errors.Is(fixture.Gateway.PollOnce(t.Context()), ErrIncoming) {
			t.Fatal("polling accepted an invalid or unbounded result collection")
		}
	}
}
