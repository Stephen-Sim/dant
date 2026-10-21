package skills

import (
	"context"
	"encoding/json"
	"regexp"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	SupportFileLimit       = 128
	TreeEntryLimit         = 4096
	DescriptionBytes       = 1000
	InstructionBytes       = 49152
	FileBytes              = 8 * 1024 * 1024
	TotalBytes             = 9 * 1024 * 1024
	ArchiveBytes           = 10 * 1024 * 1024
	EditorFileBytes        = 256 * 1024
	EditorTotalBytes       = 1024 * 1024
	EditorJSONBytes        = 2 * 1024 * 1024
	MaxDepth               = 16
	RelativePathCharacters = 180
	markerName             = ".dant-managed.json"
	markerBytes            = 8192 + SupportFileLimit*1100
	PreviewLifetime        = 10 * time.Minute
	MaxPreviews            = 3
	ImportDeadline         = 30 * time.Second
)

var namePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
var supportPattern = regexp.MustCompile(`^(?:(?:scripts|references|assets)/|README\.md$|(?:LICENSE|NOTICE)(?:\.txt|\.md)?$)`)
var nonText = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f]`)

func invalid() error {
	return &contracts.APIError{Status: 400, Code: "invalid_skill", Message: "The skill has invalid or unsupported instructions or metadata."}
}

func limited() error {
	return &contracts.APIError{Status: 400, Code: "size_limit", Message: "The skill exceeds the supported file count or size limit."}
}

func missing() error {
	return &contracts.APIError{Status: 404, Code: "not_found", Message: "Skill not found."}
}

func exists() error {
	return &contracts.APIError{Status: 409, Code: "name_exists", Message: "A skill or unmanaged folder with this name already exists. Choose another name."}
}

func credentials() error {
	return &contracts.APIError{Status: 400, Code: "credentials", Message: "Keep credentials in the credential vault, not in skills."}
}

type Summary struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Enabled     bool    `json:"enabled"`
	Path        string  `json:"path"`
	UpdatedAt   float64 `json:"updatedAt"`
}

type BinaryFile struct {
	Encoding  string `json:"encoding"`
	MediaType string `json:"mediaType"`
	Data      string `json:"data"`
}

type Asset struct {
	Path      string `json:"path"`
	MediaType string `json:"mediaType"`
	Size      int    `json:"size"`
}

type View struct {
	Summary
	Instructions string            `json:"instructions"`
	Files        map[string]string `json:"files"`
	Assets       []Asset           `json:"assets,omitempty"`
}

type Snapshot struct {
	Summary
	Instructions string                `json:"instructions"`
	Files        map[string]string     `json:"files"`
	BinaryFiles  map[string]BinaryFile `json:"binaryFiles,omitempty"`
}

type Metadata struct {
	Owner       string   `json:"owner"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Files       []string `json:"files,omitempty"`
	UpdatedAt   float64  `json:"updatedAt"`
}

type SaveInput struct {
	Name                string                `json:"name"`
	Description         string                `json:"description"`
	Instructions        string                `json:"instructions"`
	Enabled             *bool                 `json:"enabled,omitempty"`
	Files               map[string]string     `json:"files,omitempty"`
	BinaryFiles         map[string]BinaryFile `json:"binaryFiles,omitempty"`
	PreserveBinaryFiles bool                  `json:"preserveBinaryFiles,omitempty"`
}

func DecodeSave(data []byte) (SaveInput, error) {
	object, err := contracts.DecodeObject(data, ArchiveBytes*2)
	if err != nil || !contracts.ValidUnicodeJSON(data) {
		return SaveInput{}, invalid()
	}
	for _, key := range []string{"name", "description", "instructions"} {
		var value string
		if len(object[key]) == 0 || string(object[key]) == "null" || json.Unmarshal(object[key], &value) != nil {
			return SaveInput{}, invalid()
		}
	}
	for _, key := range []string{"files", "binaryFiles", "enabled", "preserveBinaryFiles"} {
		if string(object[key]) == "null" {
			return SaveInput{}, invalid()
		}
	}
	var result SaveInput
	if json.Unmarshal(data, &result) != nil {
		return result, invalid()
	}
	if raw, exists := object["binaryFiles"]; exists {
		assets, err := contracts.DecodeObject(raw, ArchiveBytes*2)
		if err != nil {
			return result, invalid()
		}
		for _, encoded := range assets {
			fields, err := contracts.DecodeObject(encoded, ArchiveBytes*2)
			if err != nil || len(fields) != 3 {
				return result, invalid()
			}
			for _, key := range []string{"encoding", "mediaType", "data"} {
				var value string
				if string(fields[key]) == "null" || json.Unmarshal(fields[key], &value) != nil {
					return result, invalid()
				}
			}
		}
	}
	return result, nil
}

type Options struct {
	Now            func() time.Time
	ContainsSecret func(context.Context, string) bool
}
