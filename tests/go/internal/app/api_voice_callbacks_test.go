package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func awaitAppVoiceToolOutput(t *testing.T, socket *appVoiceSocket, id string) string {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		socket.mu.Lock()
		for _, event := range socket.writes {
			var item contracts.RawObject
			_ = json.Unmarshal(event["item"], &item)
			if string(item["type"]) == `"function_call_output"` && string(item["call_id"]) == string(encode(id)) {
				var output string
				_ = json.Unmarshal(item["output"], &output)
				socket.mu.Unlock()
				return output
			}
		}
		changed := socket.written
		socket.mu.Unlock()
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatal("owned API voice tool did not return a result")
		}
	}
}

func TestWorkerAPIVoiceUsageWriteFailurePublishesOnlyItsBoundedNotice(t *testing.T) {
	var fail atomic.Bool
	app, socket, _, _ := activeAPICallFixture(t, func(options *WorkerOptions) {
		options.StoreOptions.Write = func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
			if fail.Load() {
				return errors.New("synthetic private usage persistence failure")
			}
			return files.WriteAtomic(ctx, path, data, mode)
		}
	})
	defer fail.Store(false)
	client, accepted := app.events.subscribe(t.Context())
	if !accepted {
		t.Fatal("observer was not accepted")
	}
	defer app.events.remove(client)
	fail.Store(true)
	socket.input <- encode(contracts.RawObject{"type": encode("response.done"), "response": encode(contracts.RawObject{
		"id": encode("usage-failure"), "status": encode("completed"), "output": encode([]contracts.RawObject{}),
		"usage": encode(contracts.RawObject{"input_tokens": encode(7), "output_tokens": encode(3), "total_tokens": encode(10)}),
	})})
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	select {
	case notice := <-client.control:
		if !strings.Contains(string(notice), "Token usage could not be saved.") || strings.Contains(string(notice), "synthetic private") {
			t.Fatal("usage failure lost its fixed message or exposed a raw persistence error")
		}
	case <-deadline.C:
		t.Fatal("failed usage write was silently lost")
	}
}

func TestWorkerAPIVoiceCallbacksRetainSpeechTaskOwnershipUsageAndReadOnlyTools(t *testing.T) {
	app, socket, callID, _ := activeAPICallFixture(t)
	socket.mu.Lock()
	socket.written = make(chan struct{}, 64)
	socket.mu.Unlock()
	socket.input <- encode(contracts.RawObject{
		"type": encode("conversation.item.added"), "previous_item_id": encode(nil),
		"item": encode(contracts.RawObject{"id": encode("speech-input"), "type": encode("message"), "role": encode(contracts.RoleUser), "content": encode([]contracts.RawObject{{"type": encode("input_audio")}})}),
	})
	socket.input <- encode(contracts.RawObject{"type": encode("conversation.item.input_audio_transcription.completed"), "item_id": encode("speech-input"), "transcript": encode("remembered synthetic speech")})
	for index, name := range []string{"run_task", "skill_list"} {
		changes, unsubscribe := app.engine.Subscribe()
		arguments := `{}`
		if name == "run_task" {
			arguments = `{"text":"explicitly entrusted voice task"}`
		}
		id := "voice-tool-" + name
		socket.input <- encode(contracts.RawObject{"type": encode("response.done"), "response": encode(contracts.RawObject{
			"id": encode("response-" + name), "status": encode("completed"),
			"usage":  encode(contracts.RawObject{"input_tokens": encode(7), "output_tokens": encode(3), "total_tokens": encode(10)}),
			"output": encode([]contracts.RawObject{{"type": encode("function_call"), "status": encode("completed"), "call_id": encode(id), "name": encode(name), "arguments": encode(arguments)}}),
		})})
		if name == "run_task" {
			deadline := time.NewTimer(5 * time.Second)
			for {
				if scope, current := app.engine.ToolScope(); current && scope.TurnID != "" {
					if err := socket.runtimeWire.frame(contracts.RawObject{"method": encode("turn/completed"), "params": encode(contracts.RawObject{
						"threadId": encode("app-fixture-thread"), "turn": encode(contracts.RawObject{"id": encode(scope.TurnID), "status": encode(contracts.RuntimeTerminalTurnStatusCompleted)}),
					})}); err != nil {
						t.Fatal(err)
					}
					break
				}
				select {
				case <-changes:
				case <-deadline.C:
					t.Fatal("owned voice task never reached fake executor acknowledgement")
				}
			}
			deadline.Stop()
		}
		output := awaitAppVoiceToolOutput(t, socket, id)
		unsubscribe()
		if !json.Valid([]byte(output)) || strings.Contains(output, `"success":false`) {
			t.Fatal("owned callback did not complete its fake boundary operation", name, index)
		}
	}
	state := app.store.Snapshot()
	if len(state.VoiceHistory) != 1 || !strings.Contains(string(state.VoiceHistory[0]), callID) || !strings.Contains(string(state.VoiceHistory[0]), "remembered synthetic speech") {
		t.Fatal("speech callback lost exact call identity or durable reference")
	}
	usage := app.usage.Snapshot()
	if usage.APIVoice.Totals.TotalTokens == nil || *usage.APIVoice.Totals.TotalTokens != 20 {
		t.Fatal("provider usage callback did not reach its usage owner")
	}
}

func TestWorkerAPIVoiceRedactionFailurePublishesNoRawToolResult(t *testing.T) {
	app, socket, _, _ := activeAPICallFixture(t)
	directory := filepath.Join(app.options.Startup.DataDir, "credentials")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "vault.enc"), []byte("invalid synthetic vault"), 0o600); err != nil {
		t.Fatal(err)
	}
	socket.mu.Lock()
	socket.written = make(chan struct{}, 64)
	socket.mu.Unlock()
	socket.input <- encode(contracts.RawObject{"type": encode("response.done"), "response": encode(contracts.RawObject{
		"id": encode("redaction-response"), "status": encode("completed"),
		"output": encode([]contracts.RawObject{{"type": encode("function_call"), "status": encode("completed"), "call_id": encode("redaction-tool"), "name": encode("skill_list"), "arguments": encode(`{}`)}}),
	})})
	if output := awaitAppVoiceToolOutput(t, socket, "redaction-tool"); output != "" {
		t.Fatal("failed redaction exposed the raw tool result")
	}
}
