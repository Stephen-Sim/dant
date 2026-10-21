package voice

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type failedAudioStorage struct{}

func (failedAudioStorage) Read(context.Context, string) (contracts.Attachment, []byte, error) {
	return contracts.Attachment{}, nil, errors.New("isolated attachment read failure")
}

func TestTranscriptionBoundaryRejectsUnavailableInputsWithoutLaunchingAProcess(t *testing.T) {
	for _, options := range []TranscriberOptions{{Home: "relative"}, {Home: t.TempDir(), Timeout: -1}, {Home: t.TempDir(), Timeout: 2147483648 * time.Millisecond}} {
		if _, err := NewTranscriber(options); !errors.Is(err, ErrTranscriptionUnavailable) {
			t.Fatal("invalid recognition configuration was accepted", err)
		}
	}
	transcriber, err := NewTranscriber(TranscriberOptions{Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if transcriber.options.Spawn == nil || transcriber.options.Timeout != 180*time.Second || transcriber.options.Platform == "" {
		t.Fatal("default recognition boundary was not initialized")
	}
	transcriber.options.Platform = "windows"
	if _, err := transcriber.Transcribe(t.Context(), fixtureAudio().meta.ID); !errors.Is(err, ErrTranscriptionUnavailable) {
		t.Fatal("host platform launched VM audio recognition", err)
	}
	transcriber.options.Platform = "linux"
	if _, err := transcriber.Transcribe(t.Context(), "bad-id"); !errors.Is(err, ErrAudioInvalid) {
		t.Fatal("invalid attachment identity was accepted", err)
	}
	transcriber.options.Attachments = failedAudioStorage{}
	if _, err := transcriber.Transcribe(t.Context(), fixtureAudio().meta.ID); !errors.Is(err, ErrAudioInvalid) {
		t.Fatal("unreadable audio reached recognizer", err)
	}
	transcriber.options.Attachments = fixtureAudio()
	transcriber.options.Spawn = func(TranscriptionCommand) (TranscriptionProcess, error) {
		return nil, errors.New("isolated spawn failure")
	}
	if _, err := transcriber.Transcribe(t.Context(), fixtureAudio().meta.ID); !errors.Is(err, ErrTranscriptionUnavailable) {
		t.Fatal("process spawn failure exposed raw causes", err)
	}
	if err := transcriber.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := transcriber.Transcribe(t.Context(), fixtureAudio().meta.ID); !errors.Is(err, ErrTranscriptionClosed) {
		t.Fatal("closed recognizer was restarted", err)
	}
}

func TestTranscriptionClassifiesKnownHelperFailuresAndRejectsEmptySpeech(t *testing.T) {
	storage := fixtureAudio()
	for _, test := range []struct {
		name    string
		outcome TranscriptionProcessResult
		want    error
	}{
		{"no speech", TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"no_speech"}`)}, ErrNoSpeech},
		{"invalid audio", TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"invalid_audio"}`)}, ErrAudioInvalid},
		{"long audio", TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"too_long"}`)}, ErrAudioTooLong},
		{"unavailable", TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"unavailable"}`)}, ErrTranscriptionUnavailable},
		{"unknown", TranscriptionProcessResult{ExitCode: 1, Stderr: []byte(`{"error":"private-fixture-cause"}`)}, ErrTranscriptionFailed},
		{"empty speech", TranscriptionProcessResult{Output: []byte(`{"text":"  ","language":"en","duration":1}`)}, ErrNoSpeech},
		{"overflow", TranscriptionProcessResult{Overflow: true}, ErrTranscriptionInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			transcriber, err := NewTranscriber(TranscriberOptions{Home: t.TempDir(), Platform: "linux", Attachments: storage, Spawn: func(TranscriptionCommand) (TranscriptionProcess, error) {
				process := fakeAudio()
				process.done <- test.outcome
				return process, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := transcriber.Transcribe(t.Context(), storage.meta.ID); !errors.Is(err, test.want) {
				t.Fatal("recognition outcome lost its safe classification", err)
			}
			if err := transcriber.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
		})
	}
}
