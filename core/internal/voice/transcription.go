package voice

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const transcriptionOutputBytes = 128 * 1024
const transcriptionErrorBytes = 8192
const transcriptionGrace = time.Second
const transcriptionShutdown = 2 * time.Second

var ErrTranscriptionFailed = errors.New("audio_recognition_failed")
var ErrTranscriptionUnavailable = errors.New("audio_recognition_unavailable")
var ErrTranscriptionInvalid = errors.New("audio_recognition_invalid_result")
var ErrAudioInvalid = errors.New("audio_attachment_invalid")
var ErrNoSpeech = errors.New("audio_no_speech")
var ErrAudioTooLong = errors.New("audio_too_long")
var ErrTranscriptionTimeout = errors.New("audio_recognition_timeout")
var ErrTranscriptionShutdown = errors.New("audio_recognition_shutdown_unconfirmed")
var ErrTranscriptionClosed = errors.New("audio_recognition_closed")
var audioID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var audioLanguage = regexp.MustCompile(`(?i)^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$`)

type AudioStorage interface {
	Read(context.Context, string) (contracts.Attachment, []byte, error)
}

type TranscriptionResult struct {
	Text     string  `json:"text"`
	Language string  `json:"language"`
	Duration float64 `json:"duration"`
}

type TranscriptionCommand struct {
	Program     string
	Args        []string
	Directory   string
	Environment []string
	Input       []byte
}

type TranscriptionProcessResult struct {
	Output, Stderr []byte
	ExitCode       int
	Error          error
	Overflow       bool
}

type TranscriptionProcess interface {
	Done() <-chan TranscriptionProcessResult
	Overflow() <-chan struct{}
	Terminate() error
	Kill() error
}

type TranscriptionSpawn func(TranscriptionCommand) (TranscriptionProcess, error)
type TranscriberOptions struct {
	Attachments    AudioStorage
	Home, Platform string
	Spawn          TranscriptionSpawn
	Timeout        time.Duration
}

type Transcriber struct {
	mu              sync.Mutex
	options         TranscriberOptions
	gate            chan struct{}
	shutdown        chan struct{}
	closed, blocked bool
}

func NewTranscriber(options TranscriberOptions) (*Transcriber, error) {
	if options.Platform == "" {
		options.Platform = runtime.GOOS
	}
	if options.Timeout == 0 {
		options.Timeout = 180 * time.Second
	}
	if !filepath.IsAbs(options.Home) || options.Timeout < time.Millisecond || options.Timeout > 2147483647*time.Millisecond {
		return nil, ErrTranscriptionUnavailable
	}
	if options.Spawn == nil {
		options.Spawn = spawnTranscription
	}
	return &Transcriber{options: options, gate: make(chan struct{}, 1), shutdown: make(chan struct{})}, nil
}

func (t *Transcriber) Transcribe(ctx context.Context, id string) (TranscriptionResult, error) {
	select {
	case <-ctx.Done():
		return TranscriptionResult{}, ctx.Err()
	case <-t.shutdown:
		return TranscriptionResult{}, ErrTranscriptionClosed
	case t.gate <- struct{}{}:
	}
	defer func() { <-t.gate }()
	t.mu.Lock()
	closed, blocked := t.closed, t.blocked
	t.mu.Unlock()
	if closed {
		return TranscriptionResult{}, ErrTranscriptionClosed
	}
	if blocked {
		return TranscriptionResult{}, ErrTranscriptionShutdown
	}
	if t.options.Platform != "linux" {
		return TranscriptionResult{}, ErrTranscriptionUnavailable
	}
	if !audioID.MatchString(id) || t.options.Attachments == nil {
		return TranscriptionResult{}, ErrAudioInvalid
	}
	meta, data, err := t.options.Attachments.Read(ctx, id)
	if err != nil {
		return TranscriptionResult{}, ErrAudioInvalid
	}
	size, ok := meta.Size.Get()
	kind, inspectErr := files.InspectContent(data, meta.Name)
	digest := sha256.Sum256(data)
	if !ok || size != float64(len(data)) || meta.ID != id || len(data) == 0 || len(data) > files.MaxAttachmentBytes || inspectErr != nil || kind != meta.Type || (kind != "audio/wav" && kind != "audio/ogg" && kind != "audio/mpeg" && kind != "audio/webm") || hex.EncodeToString(digest[:]) != meta.Hash {
		return TranscriptionResult{}, ErrAudioInvalid
	}
	if err = ctx.Err(); err != nil {
		return TranscriptionResult{}, err
	}
	root := filepath.Join(t.options.Home, "dant")
	recognition := filepath.Join(root, "runtime", "transcription")
	command := TranscriptionCommand{Program: filepath.Join(recognition, "venv", "bin", "python"), Args: []string{filepath.Join(root, "vm", "transcribe_audio.py"), "--model-dir", filepath.Join(recognition, "model")}, Directory: root, Input: data, Environment: []string{"HOME=" + t.options.Home, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "PYTHONNOUSERSITE=1", "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1", "OMP_NUM_THREADS=2", "TOKENIZERS_PARALLELISM=false", "CUDA_VISIBLE_DEVICES="}}
	child, err := t.options.Spawn(command)
	if err != nil {
		return TranscriptionResult{}, ErrTranscriptionUnavailable
	}
	timer := time.NewTimer(t.options.Timeout)
	defer timer.Stop()
	var outcome TranscriptionProcessResult
	var stopping error
	select {
	case outcome = <-child.Done():
	case <-ctx.Done():
		stopping = ctx.Err()
	case <-t.shutdown:
		stopping = context.Canceled
	case <-timer.C:
		stopping = ErrTranscriptionTimeout
	case <-child.Overflow():
		stopping = ErrTranscriptionInvalid
	}
	if stopping != nil {
		_ = child.Terminate()
		grace := time.NewTimer(transcriptionGrace)
		defer grace.Stop()
		deadline := time.NewTimer(transcriptionShutdown)
		defer deadline.Stop()
		for {
			select {
			case <-child.Done():
				return TranscriptionResult{}, stopping
			case <-grace.C:
				_ = child.Kill()
			case <-deadline.C:
				t.mu.Lock()
				t.blocked = true
				t.mu.Unlock()
				return TranscriptionResult{}, ErrTranscriptionShutdown
			}
		}
	}
	if outcome.Error != nil || outcome.ExitCode != 0 {
		if len(outcome.Stderr) <= transcriptionErrorBytes {
			var value struct{ Error string }
			if json.Unmarshal(outcome.Stderr, &value) == nil {
				switch value.Error {
				case "no_speech":
					return TranscriptionResult{}, ErrNoSpeech
				case "invalid_audio":
					return TranscriptionResult{}, ErrAudioInvalid
				case "too_long":
					return TranscriptionResult{}, ErrAudioTooLong
				case "unavailable":
					return TranscriptionResult{}, ErrTranscriptionUnavailable
				}
			}
		}
		return TranscriptionResult{}, ErrTranscriptionFailed
	}
	if outcome.Overflow || len(outcome.Output) > transcriptionOutputBytes || !utf8.Valid(outcome.Output) {
		return TranscriptionResult{}, ErrTranscriptionInvalid
	}
	var result TranscriptionResult
	value, err := contracts.DecodeObject(outcome.Output, transcriptionOutputBytes)
	if err != nil || string(value["text"]) == "null" || string(value["language"]) == "null" || json.Unmarshal(outcome.Output, &result) != nil {
		return TranscriptionResult{}, ErrTranscriptionInvalid
	}
	if contracts.TrimText(result.Text) == "" {
		return TranscriptionResult{}, ErrNoSpeech
	}
	if !captionTextControls(result.Text) || !audioLanguage.MatchString(result.Language) || len(result.Language) > 32 || math.IsNaN(result.Duration) || math.IsInf(result.Duration, 0) || result.Duration <= 0 || result.Duration > 600 {
		return TranscriptionResult{}, ErrTranscriptionInvalid
	}
	result.Text = contracts.TrimText(result.Text)
	return result, nil
}

func captionTextControls(text string) bool {
	for _, c := range text {
		if c <= 8 || c == 11 || c == 12 || c >= 14 && c <= 31 {
			return false
		}
	}
	return true
}

func (t *Transcriber) Close(ctx context.Context) error {
	t.mu.Lock()
	if !t.closed {
		t.closed = true
		close(t.shutdown)
	}
	t.mu.Unlock()
	select {
	case t.gate <- struct{}{}:
		defer func() { <-t.gate }()
	case <-ctx.Done():
		return ErrTranscriptionShutdown
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.blocked {
		return ErrTranscriptionShutdown
	}
	return nil
}
