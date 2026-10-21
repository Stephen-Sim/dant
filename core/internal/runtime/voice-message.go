package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const VoiceMessageTimeout = 55 * time.Second
const VoiceMessageTextChars = 2500
const VoiceMessageOutputBytes = 8192
const VoiceMessageErrorBytes = 4096

var ErrVoiceMessage = errors.New("vm_voice_message_failed")

type VoiceMessageOptions struct {
	Text            string
	OutputDirectory string
	Language        string
	Voice           string
}

type VoiceFile struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type VoiceMessageCommand struct {
	Script          string
	OutputDirectory string
	Input           json.RawMessage
}

type voiceOutputTail struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (value *voiceOutputTail) Write(data []byte) (int, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	count := len(data)
	if len(data) >= value.limit {
		value.data = append(value.data[:0], data[len(data)-value.limit:]...)
	} else {
		value.data = append(value.data, data...)
		if len(value.data) > value.limit {
			value.data = append(value.data[:0], value.data[len(value.data)-value.limit:]...)
		}
	}
	return count, nil
}

func runVoiceMessageCommand(ctx context.Context, input VoiceMessageCommand) ([]byte, error) {
	command := exec.CommandContext(ctx, pythonExecutable, input.Script, "--output-dir", input.OutputDirectory)
	command.WaitDelay = time.Second
	command.Stdin = strings.NewReader(string(input.Input))
	output := &voiceOutputTail{limit: VoiceMessageOutputBytes}
	privateError := &voiceOutputTail{limit: VoiceMessageErrorBytes}
	command.Stdout = output
	command.Stderr = privateError
	if command.Run() != nil {
		return nil, ErrVoiceMessage
	}
	return append([]byte(nil), output.data...), nil
}

// CreateVoiceMessage is a Worker-only capability. The Controller cannot use
// it to spawn a speech helper or create files on the host computer.
func (value *LocalWorker) CreateVoiceMessage(ctx context.Context, input VoiceMessageOptions) (VoiceFile, error) {
	value.mu.Lock()
	status, generation, rpc := value.status, value.generation, value.rpc
	value.mu.Unlock()
	if value.options.Platform != "linux" || *value.options.UID <= 0 || status != contracts.ConnectionStatusOnline || rpc == nil {
		return VoiceFile{}, ErrWorkerRole
	}
	if contracts.TrimText(input.Text) == "" || contracts.UTF16Length(input.Text) > VoiceMessageTextChars {
		return VoiceFile{}, ErrVoiceMessage
	}
	conversationID := value.conversationID()
	root := filepath.Join(value.options.WorkspaceRoot, conversationID)
	directory, err := filepath.Abs(input.OutputDirectory)
	if err != nil || input.OutputDirectory == "" {
		return VoiceFile{}, ErrVoiceMessage
	}
	relative, err := filepath.Rel(root, directory)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return VoiceFile{}, ErrVoiceMessage
	}
	if _, err = files.OrdinaryDirectory(directory, true); err != nil {
		return VoiceFile{}, ErrVoiceMessage
	}
	if !value.current(generation, conversationID, rpc) {
		return VoiceFile{}, ErrConnectionChanged
	}

	run := value.options.RunVoiceMessage
	if run == nil {
		run = runVoiceMessageCommand
	}
	request := VoiceMessageCommand{
		Script:          filepath.Join(value.options.Home, "dant", "vm", "voice_message.py"),
		OutputDirectory: directory,
		Input:           voiceMessageInput(input.Text, input.Language),
	}
	deadline, cancel := context.WithTimeout(ctx, VoiceMessageTimeout)
	defer cancel()
	output, err := run(deadline, request)
	if err != nil {
		return VoiceFile{}, ErrVoiceMessage
	}
	if !value.current(generation, conversationID, rpc) {
		return VoiceFile{}, &OperationError{Cause: ErrConnectionChanged, UnknownOutcome: true}
	}
	if len(output) > VoiceMessageOutputBytes || !contracts.ValidUnicodeJSON(output) {
		return VoiceFile{}, ErrVoiceMessage
	}
	object, err := contracts.DecodeObject(output, VoiceMessageOutputBytes)
	if err != nil {
		return VoiceFile{}, ErrVoiceMessage
	}
	var result VoiceFile
	encoded, _ := json.Marshal(object)
	if json.Unmarshal(encoded, &result) != nil || result.Path == "" || result.Type != "audio/wav" {
		return VoiceFile{}, ErrVoiceMessage
	}
	result.Path, err = filepath.Abs(result.Path)
	if err != nil || filepath.Dir(result.Path) != directory {
		return VoiceFile{}, ErrVoiceMessage
	}
	return result, nil
}

func voiceMessageInput(text, language string) json.RawMessage {
	encoded, _ := json.Marshal(struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}{Text: text, Language: language})
	return encoded
}
