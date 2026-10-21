package voice

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type audioReadBoundary func(context.Context, string) (contracts.Attachment, []byte, error)

func (read audioReadBoundary) Read(ctx context.Context, id string) (contracts.Attachment, []byte, error) {
	return read(ctx, id)
}

func TestTranscriptionGateCancellationAndShutdownNeverSpawnARecognizer(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled caller", true: "closed owner"}[shutdown], func(t *testing.T) {
			transcriber, err := NewTranscriber(TranscriberOptions{Home: t.TempDir(), Platform: "linux"})
			if err != nil {
				t.Fatal(err)
			}
			transcriber.gate <- struct{}{}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			want := context.Canceled
			if shutdown {
				transcriber.closed = true
				close(transcriber.shutdown)
				want = ErrTranscriptionClosed
			} else {
				cancel()
			}
			if _, err := transcriber.Transcribe(ctx, fixtureAudio().meta.ID); !errors.Is(err, want) {
				t.Fatal("gate wait ignored cancellation or the ended recognizer owner", err)
			}
			cancel()
			if err := transcriber.Close(ctx); !errors.Is(err, ErrTranscriptionShutdown) {
				t.Fatal("occupied recognition gate was reported as joined", err)
			}
			<-transcriber.gate
			if err := transcriber.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTranscriptionRechecksCallerAfterVerifiedFileRead(t *testing.T) {
	storage := fixtureAudio()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	transcriber, err := NewTranscriber(TranscriberOptions{Home: t.TempDir(), Platform: "linux", Attachments: audioReadBoundary(func(ctx context.Context, id string) (contracts.Attachment, []byte, error) {
		metadata, data, err := storage.Read(ctx, id)
		cancel()
		return metadata, data, err
	}), Spawn: func(TranscriptionCommand) (TranscriptionProcess, error) {
		t.Error("cancelled file read launched recognition")
		return nil, ErrTranscriptionUnavailable
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transcriber.Transcribe(ctx, storage.meta.ID); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled verified input became a recognition command", err)
	}
	if err := transcriber.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestTranscriptionTimeoutOverflowAndShutdownJoinOnlyTheirOwnedProcess(t *testing.T) {
	for _, stop := range []string{"timeout", "overflow", "shutdown"} {
		t.Run(stop, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				process := fakeAudio()
				process.ack = true
				started := make(chan struct{})
				transcriber, err := NewTranscriber(TranscriberOptions{Home: t.TempDir(), Platform: "linux", Attachments: fixtureAudio(), Timeout: time.Millisecond, Spawn: func(TranscriptionCommand) (TranscriptionProcess, error) {
					close(started)
					return process, nil
				}})
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() { _, err := transcriber.Transcribe(t.Context(), fixtureAudio().meta.ID); done <- err }()
				<-started
				want := ErrTranscriptionTimeout
				var closeDone chan error
				switch stop {
				case "overflow":
					close(process.overflow)
					want = ErrTranscriptionInvalid
				case "shutdown":
					closeDone = make(chan error, 1)
					go func() { closeDone <- transcriber.Close(t.Context()) }()
					want = context.Canceled
				}
				if err := <-done; !errors.Is(err, want) || process.terminates.Load() != 1 || process.kills.Load() != 0 {
					t.Fatal("recognition did not confirm its own bounded stop", err)
				}
				if closeDone != nil {
					if err := <-closeDone; err != nil {
						t.Fatal("joined recognizer retained an unconfirmed shutdown", err)
					}
				}
				if err := transcriber.Close(t.Context()); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}
