package voice

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

//go:embed data/api-tools.json
var apiToolsJSON []byte

//go:embed data/instructions.json
var voiceInstructionsJSON []byte
var voiceAssetsOnce sync.Once
var voiceInstructions map[string]string
var voiceTools []json.RawMessage

type toolRule struct {
	Type                                json.RawMessage
	MaxLength, MinLength, MaxProperties int
	AdditionalProperties                *struct {
		Type      string
		MaxLength int
	}
}

type voiceTool struct {
	Name       string
	Parameters struct {
		Properties map[string]toolRule
		Required   []string
	}
}

var voiceToolSpecs map[string]voiceTool

func loadVoiceAssets() {
	_ = json.Unmarshal(voiceInstructionsJSON, &voiceInstructions)
	_ = json.Unmarshal(apiToolsJSON, &voiceTools)
	voiceToolSpecs = map[string]voiceTool{}
	for _, raw := range voiceTools {
		var spec voiceTool
		if json.Unmarshal(raw, &spec) == nil {
			voiceToolSpecs[spec.Name] = spec
		}
	}
}

func VoiceTools() []json.RawMessage {
	voiceAssetsOnce.Do(loadVoiceAssets)
	result := make([]json.RawMessage, len(voiceTools))
	for index, raw := range voiceTools {
		result[index] = append(json.RawMessage{}, raw...)
	}
	return result
}

func voiceInstruction(key string) string {
	voiceAssetsOnce.Do(loadVoiceAssets)
	return voiceInstructions[key]
}

func validAPIVoice(value string) bool {
	for _, voice := range apiVoices {
		if voice == value {
			return true
		}
	}
	return false
}

func voiceToolArguments(name string, raw json.RawMessage) (contracts.RawObject, error) {
	voiceAssetsOnce.Do(loadVoiceAssets)
	spec, ok := voiceToolSpecs[name]
	if !ok {
		return nil, ErrCallInput
	}
	var quoted string
	if len(raw) > 0 && raw[0] == '"' {
		if json.Unmarshal(raw, &quoted) != nil {
			return nil, ErrCallInput
		}
		raw = []byte(quoted)
	}
	args, err := contracts.DecodeObject(raw, maxVoiceEventBytes)
	if err != nil {
		return nil, ErrCallInput
	}
	for _, key := range spec.Parameters.Required {
		if _, ok := args[key]; !ok {
			return nil, ErrCallInput
		}
	}
	for key, raw := range args {
		rule, ok := spec.Parameters.Properties[key]
		if !ok {
			return nil, ErrCallInput
		}
		if name == "react_message" && key == "emoji" {
			if string(raw) == "null" {
				continue
			}
			var reaction string
			if json.Unmarshal(raw, &reaction) != nil || !validReaction(reaction) {
				return nil, ErrCallInput
			}
			continue
		}
		var kind string
		_ = json.Unmarshal(rule.Type, &kind)
		switch kind {
		case "string":
			var value string
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil || strings.ContainsRune(value, 0) || rule.MaxLength > 0 && contracts.UTF16Length(value) > rule.MaxLength || rule.MinLength > 0 && (contracts.TrimText(value) == "" || contracts.UTF16Length(value) < rule.MinLength) {
				return nil, ErrCallInput
			}
		case "boolean":
			var value bool
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				return nil, ErrCallInput
			}
		case "object":
			files, err := contracts.DecodeObject(raw, maxVoiceEventBytes)
			if err != nil || rule.MaxProperties > 0 && len(files) > rule.MaxProperties {
				return nil, ErrCallInput
			}
			for path, raw := range files {
				var text string
				if contracts.UTF16Length(path) > 180 || string(raw) == "null" || json.Unmarshal(raw, &text) != nil || strings.ContainsRune(text, 0) || rule.AdditionalProperties != nil && contracts.UTF16Length(text) > rule.AdditionalProperties.MaxLength {
					return nil, ErrCallInput
				}
			}
		default:
			return nil, ErrCallInput
		}
	}
	if name == "run_task" || name == "send_message" {
		if contracts.TrimText(textField(args, "text")) == "" {
			return nil, ErrCallInput
		}
	}
	if name == "send_file" && !strings.HasPrefix(textField(args, "path"), "/") {
		return nil, ErrCallInput
	}
	return args, nil
}
