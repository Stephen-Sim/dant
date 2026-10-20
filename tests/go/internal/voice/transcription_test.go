package voice

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type audioFixtureStorage struct {
	meta contracts.Attachment
	data []byte
}

func (storage audioFixtureStorage) Read(context.Context, string) (contracts.Attachment, []byte, error) {
	return storage.meta, append([]byte{}, storage.data...), nil
}

func fixtureAudio() audioFixtureStorage {
	data := []byte("RIFF0000WAVEfixture")
	digest := sha256.Sum256(data)
	return audioFixtureStorage{contracts.Attachment{ID: "00000000-0000-4000-8000-000000000001", Name: "recording.wav", Type: "audio/wav", Hash: hex.EncodeToString(digest[:]), Size: contracts.Some(float64(len(data)))}, data}
}

type fakeAudioProcess struct {
	done              chan TranscriptionProcessResult
	overflow          chan struct{}
	terminates, kills atomic.Int32
	ack               bool
}

func fakeAudio() *fakeAudioProcess {
	return &fakeAudioProcess{done: make(chan TranscriptionProcessResult, 1), overflow: make(chan struct{})}
}

func (p *fakeAudioProcess) Done() <-chan TranscriptionProcessResult { return p.done }
func (p *fakeAudioProcess) Overflow() <-chan struct{}               { return p.overflow }
func (p *fakeAudioProcess) Terminate() error {
	p.terminates.Add(1)
	if p.ack {
		p.done <- TranscriptionProcessResult{ExitCode: -1}
	}
	return nil
}

func (p *fakeAudioProcess) Kill() error {
	p.kills.Add(1)
	return nil
}
func TestTranscriptionValidatesStoredBytesAndUsesOfflineFixedProcess(t *testing.T) {
	storage := fixtureAudio()
	calls := 0
	transcriber, err := NewTranscriber(TranscriberOptions{Attachments: storage, Home: t.TempDir(), Platform: "linux", Spawn: func(command TranscriptionCommand) (TranscriptionProcess, error) {
		calls++
		if filepath.Base(command.Program) != "python" || len(command.Args) != 3 || command.Args[1] != "--model-dir" || !strings.Contains(strings.Join(command.Environment, "|"), "HF_HUB_OFFLINE=1") || string(command.Input) != string(storage.data) {
			t.Fatal("process boundary changed")
		}
		process := fakeAudio()
		process.done <- TranscriptionProcessResult{ExitCode: 0, Output: []byte(`{"text":"  Recognized speech  ","language":"zh-CN","duration":3.5}`)}
		return process, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := transcriber.Transcribe(context.Background(), storage.meta.ID)
	if err != nil || result.Text != "Recognized speech" || result.Duration != 3.5 || calls != 1 {
		t.Fatal("transcription missing", err)
	}
	storage.meta.Hash = strings.Repeat("0", 64)
	transcriber.options.Attachments = storage
	if _, err = transcriber.Transcribe(context.Background(), storage.meta.ID); !errors.Is(err, ErrAudioInvalid) || calls != 1 {
		t.Fatal("forged bytes executed")
	}
	if err = transcriber.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTranscriptionCancellationConfirmsStopAndUnknownShutdownBlocksNewProcesses(t *testing.T) {
	for _, ack := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "unknown"}[ack], func(t *testing.T) {
			process := fakeAudio()
			process.ack = ack
			started := make(chan struct{})
			storage := fixtureAudio()
			calls := 0
			transcriber, err := NewTranscriber(TranscriberOptions{Attachments: storage, Home: t.TempDir(), Platform: "linux", Spawn: func(TranscriptionCommand) (TranscriptionProcess, error) { calls++; close(started); return process, nil }})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { _, err := transcriber.Transcribe(ctx, storage.meta.ID); done <- err }()
			select {
			case <-started:
			case <-time.After(time.Second):
				cancel()
				t.Fatal("fixture recognizer was not started")
			}
			cancel()
			err = <-done
			if ack && !errors.Is(err, context.Canceled) || !ack && !errors.Is(err, ErrTranscriptionShutdown) {
				t.Fatal("stop confirmation changed", err)
			}
			if process.terminates.Load() != 1 || !ack && process.kills.Load() != 1 {
				t.Fatal("owned process stop not bounded")
			}
			if !ack {
				if _, err = transcriber.Transcribe(context.Background(), storage.meta.ID); !errors.Is(err, ErrTranscriptionShutdown) || calls != 1 {
					t.Fatal("unknown process was retried")
				}
			}
			closeCtx, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			err = transcriber.Close(closeCtx)
			if ack && err != nil || !ack && !errors.Is(err, ErrTranscriptionShutdown) {
				t.Fatal("close confirmation changed", err)
			}
		})
	}
}

func TestTranscriptionRejectsInvalidAndUnboundedHelperResults(t *testing.T) {
	storage := fixtureAudio()
	for _, raw := range []string{`{"text":"recognized","language":"en","duration":601}`, `{"text":"bad\u0000","language":"en","duration":1}`, `{"text":"x","language":"invalid_language","duration":1}`, `{"text":null,"language":"en","duration":1}`, strings.Repeat("x", transcriptionOutputBytes+1)} {
		transcriber, _ := NewTranscriber(TranscriberOptions{Attachments: storage, Home: t.TempDir(), Platform: "linux", Spawn: func(TranscriptionCommand) (TranscriptionProcess, error) {
			process := fakeAudio()
			process.done <- TranscriptionProcessResult{Output: []byte(raw)}
			return process, nil
		}})
		if _, err := transcriber.Transcribe(context.Background(), storage.meta.ID); !errors.Is(err, ErrTranscriptionInvalid) {
			t.Fatal("invalid helper result accepted", err)
		}
		_ = transcriber.Close(context.Background())
	}
}
