package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestVoiceMessageRejectsInvalidHelperResultsAndOutputLocations(t *testing.T) {
	fixture := newRPCFixture(t)
	worker, source := workerFixture(t, WorkerOptions{})
	worker.status, worker.rpc = contracts.ConnectionStatusOnline, fixture.client
	directory := filepath.Join(worker.WorkspaceRoot(), source.Snapshot().ConversationID, "output")
	for _, test := range []struct {
		name string
		raw  string
		err  error
	}{
		{"command failure", "", errors.New("isolated helper failure")},
		{"oversized", strings.Repeat("x", VoiceMessageOutputBytes+1), nil},
		{"invalid unicode", `{"path":"\ud800","type":"audio/wav"}`, nil},
		{"not object", `[]`, nil},
		{"bad type", `{"path":"voice.wav","type":"text/plain"}`, nil},
		{"outside output", `{"path":"outside/voice.wav","type":"audio/wav"}`, nil},
		{"missing path", `{"type":"audio/wav"}`, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			worker.options.RunVoiceMessage = func(context.Context, VoiceMessageCommand) ([]byte, error) { return []byte(test.raw), test.err }
			if _, err := worker.CreateVoiceMessage(t.Context(), VoiceMessageOptions{Text: "isolated text", OutputDirectory: directory}); !errors.Is(err, ErrVoiceMessage) {
				t.Fatal("invalid helper result escaped its fixed capability", err)
			}
		})
	}
	for _, output := range []string{"", filepath.Dir(directory), filepath.Dir(worker.WorkspaceRoot())} {
		if _, err := worker.CreateVoiceMessage(t.Context(), VoiceMessageOptions{Text: "request", OutputDirectory: output}); !errors.Is(err, ErrVoiceMessage) {
			t.Fatal("invalid output directory was accepted", err)
		}
	}
	worker.status = contracts.ConnectionStatusOffline
	if _, err := worker.CreateVoiceMessage(t.Context(), VoiceMessageOptions{Text: "request", OutputDirectory: directory}); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("offline worker launched speech helper", err)
	}
}

func TestVoiceOutputTailKeepsOnlyTheNewestBoundedBytes(t *testing.T) {
	output := &voiceOutputTail{limit: 4}
	for _, data := range []string{"ab", "cd", "ef", "123456"} {
		if n, err := output.Write([]byte(data)); err != nil || n != len(data) {
			t.Fatal("tail writer changed stream progress", n, err)
		}
	}
	if string(output.data) != "3456" {
		t.Fatal("speech diagnostic tail retained unbounded or stale output")
	}
}

func TestFixedSpeechCommandUsesOnlyAnIsolatedPythonFixture(t *testing.T) {
	directory := t.TempDir()
	script := filepath.Join(directory, "fixture.py")
	if err := os.WriteFile(script, []byte("import sys\nsys.stdout.write('isolated output')\n"), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := runVoiceMessageCommand(t.Context(), VoiceMessageCommand{Script: script, OutputDirectory: directory, Input: json.RawMessage(`{}`)})
	if goruntime.GOOS == "linux" {
		if err != nil || string(output) != "isolated output" {
			t.Fatal("fixed Python command did not return its isolated fixture output", err)
		}
	} else if !errors.Is(err, ErrVoiceMessage) {
		t.Fatal("non-Linux helper path was silently substituted", err)
	}
}
