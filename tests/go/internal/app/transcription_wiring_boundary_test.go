package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/voice"
)

type appTranscriptionProcess struct {
	done chan voice.TranscriptionProcessResult
}

func (process *appTranscriptionProcess) Done() <-chan voice.TranscriptionProcessResult {
	return process.done
}

func (*appTranscriptionProcess) Overflow() <-chan struct{} { return nil }

func (process *appTranscriptionProcess) Terminate() error {
	select {
	case process.done <- voice.TranscriptionProcessResult{ExitCode: -1}:
	default:
	}
	return nil
}

func (process *appTranscriptionProcess) Kill() error { return process.Terminate() }

func TestWorkerAssembledAudioRecognitionAndCallContextKeepDistinctOutcomes(t *testing.T) {
	for _, mode := range []string{"submitted", "context-rejected", "recognition-failed"} {
		t.Run(mode, func(t *testing.T) {
			app, socket, callID, _ := activeAPICallFixture(t)
			if err := app.transcriber.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
			audio := []byte("RIFF0000WAVEisolated recording")
			process := &appTranscriptionProcess{done: make(chan voice.TranscriptionProcessResult, 1)}
			var spawns atomic.Int32
			transcriber, err := voice.NewTranscriber(voice.TranscriberOptions{
				Attachments: app.attachments, Home: app.options.Startup.Home, Platform: "linux",
				Spawn: func(command voice.TranscriptionCommand) (voice.TranscriptionProcess, error) {
					spawns.Add(1)
					if !bytes.Equal(command.Input, audio) {
						t.Error("assembled transcription changed the validated attachment bytes")
					}
					return process, nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			app.transcriber = transcriber
			socket.mu.Lock()
			socket.rejectContext = mode == "context-rejected"
			socket.mu.Unlock()
			observer, stopObserving, err := app.engine.SubscribeSignals()
			if err != nil {
				t.Fatal("notice observer was not admitted", err)
			}
			defer stopObserving()
			file, err := app.attachments.Put(t.Context(), "isolated.wav", "audio/wav", audio)
			if err != nil {
				t.Fatal(err)
			}
			changes, unsubscribe := app.engine.Subscribe()
			defer unsubscribe()
			response := callWorker(app, http.MethodPost, "/api/messages", string(encode(contracts.RawObject{
				"text": encode("inspect this recording"), "attachments": encode([]string{file.ID}),
				"clientMessageId": encode("98f9a745-08b4-4581-a383-6d975b15d48c"),
			})))
			requireWorkerStatus(t, response, http.StatusOK)
			outcome := voice.TranscriptionProcessResult{Output: []byte(`{"text":"recognized isolated speech","language":"en","duration":2}`)}
			if mode == "recognition-failed" {
				outcome = voice.TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"invalid_audio"}`)}
			}
			process.done <- outcome
			var message contracts.ChatMessage
			if json.Unmarshal(response.Body.Bytes(), &message) != nil || message.ID == "" {
				t.Fatal("audio input was not durably admitted")
			}
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			for {
				saved, err := app.store.Message(message.ID)
				if err != nil {
					t.Fatal(err)
				}
				if mode == "recognition-failed" {
					if saved.Status.Value == contracts.MessageStatus(contracts.TaskStatusFailed) && app.engine.Snapshot().Active == nil {
						if saved.UnknownOutcome || socket.runtimeWire.count("turn/start") != 0 {
							t.Fatal("known recognition failure submitted a model turn or invented uncertainty")
						}
						break
					}
				} else if owner, current := app.engine.ToolScope(); current {
					if owner.MessageID != message.ID || socket.runtimeWire.count("turn/start") != 1 {
						t.Fatal("recognized input lost exact acknowledged task ownership")
					}
					break
				}
				select {
				case <-changes:
				case <-deadline.C:
					t.Fatal("assembled recognition did not reach a bounded task outcome")
				}
			}
			if spawns.Load() != 1 {
				t.Fatal("recognition was replayed or did not cross its process boundary")
			}
			if mode == "context-rejected" {
				select {
				case notice := <-observer:
					if notice.Type != "notice" || !strings.Contains(string(notice.Data), "recognized") || !strings.Contains(string(notice.Data), "not be retried") {
						t.Fatal("unconfirmed call context omitted its bounded no-retry guidance")
					}
				case <-deadline.C:
					t.Fatal("unconfirmed recognized call input was silently lost")
				}
			}
			if call := app.calls.Snapshot(); call == nil || call.ID != callID {
				t.Fatal("recognition failure changed call identity")
			}
		})
	}
}
