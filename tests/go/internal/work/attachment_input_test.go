package work

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

type attachmentReaderFunc func(context.Context, string) (contracts.Attachment, []byte, error)

func (read attachmentReaderFunc) Read(ctx context.Context, id string) (contracts.Attachment, []byte, error) {
	return read(ctx, id)
}

func restoredInputAttachments(t *testing.T) ([]contracts.Attachment, *files.AttachmentStore, string) {
	t.Helper()
	oldRoot := t.TempDir()
	prior, err := files.OpenAttachmentStore(oldRoot)
	if err != nil {
		t.Fatal(err)
	}
	current, err := files.OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var attachments []contracts.Attachment
	for _, input := range []struct {
		name, kind string
		data       []byte
	}{
		{"restored.png", "image/png", []byte{137, 80, 78, 71, 13, 10, 26, 10, 1}},
		{"restored.txt", "text/plain", []byte("Preserved synthetic document")},
		{"restored.ogg", "audio/ogg", []byte("OggSsynthetic audio")},
	} {
		attachment, err := prior.Put(t.Context(), input.name, input.kind, input.data)
		if err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{".bin", ".json"} {
			raw, err := os.ReadFile(filepath.Join(prior.Directory(), attachment.ID+suffix))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(current.Directory(), attachment.ID+suffix), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Remove(attachment.GuestPath); err != nil {
			t.Fatal(err)
		}
		attachments = append(attachments, attachment)
	}
	return attachments, current, oldRoot
}

func TestRestoredAttachmentsReachTheExecutorOnlyThroughCurrentVerifiedStorage(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	historical, current, oldRoot := restoredInputAttachments(t)
	engine.options.Attachments = current
	var transcription atomic.Int32
	engine.options.Transcribe = func(ctx context.Context, file contracts.Attachment) (string, error) {
		transcription.Add(1)
		if file.ID != historical[2].ID || file.GuestPath != filepath.Join(current.Directory(), file.ID+".bin") || file.Path != "" {
			t.Error("transcription received historical attachment metadata")
		}
		return "Recognized synthetic instruction", ctx.Err()
	}
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Inspect my restored attachments", Attachments: historical,
		Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resumed, err := engine.ResumePaused(t.Context(), []string{message.ID}, ResumeOptions{}); err != nil || len(resumed) != 1 || resumed[0] != message.ID {
		t.Fatal(err)
	}
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"restored-thread"}`)}}
	turn := nextRequest(t, worker, "turn/start")
	input := turn.params["input"]
	if bytes.Contains(input, []byte(oldRoot)) {
		t.Error("executor input retained an old VM path")
	}
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
		Path string `json:"path"`
	}
	if json.Unmarshal(input, &items) != nil || len(items) != 2 || items[1].Type != "localImage" || items[1].Path != filepath.Join(current.Directory(), historical[0].ID+".bin") {
		t.Error("restored image did not use the current attachment path")
	}
	if len(items) > 0 {
		if strings.Contains(items[0].Text, oldRoot) {
			t.Error("executor text retained an old VM path")
		}
		for _, file := range historical[1:] {
			if !strings.Contains(items[0].Text, filepath.Join(current.Directory(), file.ID+".bin")) {
				t.Error("restored document or audio did not use the current attachment path")
			}
		}
		if !strings.Contains(items[0].Text, "Recognized synthetic instruction") {
			t.Error("voice recognition was lost while resolving its current file")
		}
	}
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": json.RawMessage(`{"id":"restored-turn"}`)}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "restored-turn"
	})
	saved, err := persistence.Message(message.ID)
	if err != nil || saved.ID != message.ID || saved.Text != message.Text || !bytes.Equal(raw(saved.Attachments), raw(historical)) || transcription.Load() != 1 {
		t.Fatal("input resolution changed the persisted message or skipped audio validation")
	}
}

func TestAttachmentResolutionFailureNeverSubmitsATurnOrFallsBackToHistoricalPaths(t *testing.T) {
	for _, scenario := range []string{"missing reader", "missing binary", "later missing binary", "changed hash", "missing metadata", "reader failure", "wrong identity", "missing current path", "cancelled read"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			historical, current, _ := restoredInputAttachments(t)
			inputFiles := historical[:1]
			engine.options.Attachments = current
			switch scenario {
			case "missing reader":
				engine.options.Attachments = nil
			case "missing binary", "later missing binary":
				if scenario == "later missing binary" {
					inputFiles = []contracts.Attachment{historical[2], historical[0]}
				}
				if err := os.Remove(filepath.Join(current.Directory(), historical[0].ID+".bin")); err != nil {
					t.Fatal(err)
				}
			case "changed hash":
				if err := os.WriteFile(filepath.Join(current.Directory(), historical[0].ID+".bin"), bytes.Repeat([]byte{1}, int(historical[0].Size.Value)), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing metadata":
				if err := os.Remove(filepath.Join(current.Directory(), historical[0].ID+".json")); err != nil {
					t.Fatal(err)
				}
			default:
				engine.options.Attachments = attachmentReaderFunc(func(ctx context.Context, id string) (contracts.Attachment, []byte, error) {
					file, data, err := current.Read(ctx, id)
					switch scenario {
					case "reader failure":
						return contracts.Attachment{}, nil, errors.New("isolated_attachment_failure")
					case "wrong identity":
						file.ID = historical[1].ID
					case "missing current path":
						file.GuestPath, file.Path = "", ""
					case "cancelled read":
						engine.mu.Lock()
						cancel := engine.active.cancelPreparation
						engine.mu.Unlock()
						cancel()
					}
					return file, data, err
				})
			}
			var transcriptions atomic.Int32
			engine.options.Transcribe = func(context.Context, contracts.Attachment) (string, error) {
				transcriptions.Add(1)
				return "This must not be reached", nil
			}
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Inspect restored image", Attachments: inputFiles,
				Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted),
			})
			if err != nil {
				t.Fatal(err)
			}
			if resumed, err := engine.ResumePaused(t.Context(), []string{message.ID}, ResumeOptions{}); err != nil || len(resumed) != 1 || resumed[0] != message.ID {
				t.Fatal(err)
			}
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"restored-thread"}`)}}
			waitSnapshot(t, engine, func(snapshot Snapshot) bool {
				return snapshot.Active == nil && len(snapshot.Queue) == 0
			})
			select {
			case request := <-worker.requests:
				t.Fatalf("failed attachment resolution dispatched %s", request.method)
			default:
			}
			if transcriptions.Load() != 0 {
				t.Fatal("an invalid attachment reached recognition")
			}
			saved, err := persistence.Message(message.ID)
			if err != nil || saved.Submission.Value == contracts.SubmissionStatusSubmitting || saved.Submission.Value == contracts.SubmissionStatusConfirmed || !bytes.Equal(raw(saved.Attachments), raw(inputFiles)) || saved.Text != message.Text {
				t.Fatal("failed resolution changed message content or claimed submission")
			}
		})
	}
}
