package work

import (
	"context"
	_ "embed"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

//go:embed data/dynamic-tools.json
var dynamicToolsJSON []byte

//go:embed data/instructions.txt
var instructionsTemplate string

// DynamicTools returns independent canonical declarations. Schemas are shared
// with the prior runtime through a checked source projection, never evaluated
// as executable code or extended with a new permission by migration.
func DynamicTools() []json.RawMessage {
	var result []json.RawMessage
	if err := json.Unmarshal(dynamicToolsJSON, &result); err != nil {
		panic("invalid embedded tool declarations")
	}
	return result
}

func (value *Engine) buildInstructions(ctx context.Context, state contracts.State) (string, error) {
	if value.options.Instructions != "" {
		return value.options.Instructions, nil
	}

	references := []contracts.RawObject{}
	review := []contracts.WorkRecord{}
	for _, record := range state.WorkTasks {
		switch record.Status {
		case contracts.WorkStatusRunning, contracts.WorkStatusContinuing, contracts.WorkStatusWaitingUser, contracts.WorkStatusPaused:
			references = append(references, instructionWorkReference(record))
		case contracts.WorkStatusReview:
			review = append(review, record)
		}
	}
	for _, record := range review[max(0, len(review)-20):] {
		references = append(references, instructionWorkReference(record))
	}

	memoryDirectory := ""
	memory := ""
	if value.options.DurableMemory != nil {
		memoryDirectory = value.options.DurableMemory.Directory()
		var err error
		memory, err = value.options.DurableMemory.Context(ctx, false)
		if err != nil {
			return "", err
		}
	}
	desktopPath := value.options.DesktopPath
	if desktopPath == "" {
		desktopPath = filepath.Join(filepath.Dir(value.worker.WorkspaceRoot()), "vm", "desktop.py")
	}

	replacements := strings.NewReplacer(
		"{{workspace}}", value.workspace(state.ConversationID),
		"{{outputDir}}", value.outputDirectory(state.ConversationID),
		"{{desktopPath}}", desktopPath,
		"{{memoryDir}}", memoryDirectory,
		"{{durableMemory}}", value.redact(memory),
		"{{languageName}}", i18n.Info(state.Settings.Language).Name,
		"{{workReferences}}", value.redact(string(raw(references))),
	)
	return replacements.Replace(strings.TrimSuffix(instructionsTemplate, "\n")), nil
}

func instructionWorkReference(record contracts.WorkRecord) contracts.RawObject {
	return contracts.RawObject{
		"workId": raw(record.ID),
		"title":  raw(record.Title),
		"status": raw(record.Status),
		"plan":   raw(record.Plan),
	}
}
