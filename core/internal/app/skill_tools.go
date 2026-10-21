package app

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type SkillDiscovery struct {
	Refreshed  bool  `json:"refreshed"`
	Discovered *bool `json:"discovered,omitempty"`
	Errors     *int  `json:"errors,omitempty"`
}

type skillRefresh struct {
	workspace string
	current   func() bool
	request   func(context.Context, string, contracts.RawObject) (contracts.RawObject, error)
}

// refreshSkills reports an independent read-only discovery result. A failed or
// stale refresh never changes whether the caller already saved the skill.
func (app *WorkerApp) refreshSkills(ctx context.Context, owner work.ToolContext, skill skills.View) SkillDiscovery {
	if app.worker == nil || app.store == nil || owner.ConversationID == "" {
		return SkillDiscovery{}
	}
	initial := app.worker.Snapshot()
	current := func() bool {
		if ctx.Err() != nil || app.ctx.Err() != nil || app.store.ConversationID() != owner.ConversationID {
			return false
		}
		state := app.worker.Snapshot()
		if state.Status != contracts.ConnectionStatusOnline || state.Generation != initial.Generation || state.RuntimeID != initial.RuntimeID {
			return false
		}
		_, err := app.toolOwner(owner)
		return err == nil
	}
	return refreshSkillDiscovery(ctx, skillRefresh{
		workspace: filepath.Join(app.options.Startup.WorkspaceRoot, owner.ConversationID),
		current:   current, request: app.worker.Request,
	}, skill)
}

func refreshSkillDiscovery(ctx context.Context, options skillRefresh, skill skills.View) SkillDiscovery {
	failed := SkillDiscovery{}
	if options.current == nil || options.request == nil || ctx.Err() != nil || !options.current() {
		return failed
	}
	if !filepath.IsAbs(options.workspace) || filepath.Clean(options.workspace) != options.workspace {
		return failed
	}
	managed := filepath.Join(options.workspace, ".agents", "skills", skill.Name, "SKILL.md")
	disabled := filepath.Join(options.workspace, ".dant-disabled-skills", skill.Name, "SKILL.md")
	if skill.Name == "" || skill.Path != managed && skill.Path != disabled {
		return failed
	}
	result, err := options.request(ctx, "skills/list", contracts.RawObject{
		"cwds": encode([]string{options.workspace}), "forceReload": encode(true),
	})
	if err != nil || ctx.Err() != nil || !options.current() {
		return failed
	}
	data := result["data"]
	if len(data) == 0 || len(data) > workerRuntime.MaxRPCFrameBytes {
		return failed
	}
	var records []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) || json.Unmarshal(data, &records) != nil {
		return failed
	}

	found, errorCount, matched := false, 0, false
	for _, raw := range records {
		record, err := contracts.DecodeObject(raw, len(raw))
		if err != nil {
			continue
		}
		cwd, valid := discoveryString(record["cwd"])
		if !valid || cwd != options.workspace {
			continue
		}
		matched = true
		var issues []json.RawMessage
		if json.Unmarshal(record["errors"], &issues) == nil {
			errorCount += len(issues)
		}
		var candidates []json.RawMessage
		if json.Unmarshal(record["skills"], &candidates) != nil {
			continue
		}
		for _, raw := range candidates {
			candidate, err := contracts.DecodeObject(raw, len(raw))
			if err != nil {
				continue
			}
			name, nameOK := discoveryString(candidate["name"])
			path, pathOK := discoveryString(candidate["path"])
			if nameOK && pathOK && name == skill.Name && path == skill.Path && discoveryEnabled(candidate) {
				found = true
			}
		}
	}
	if ctx.Err() != nil || !options.current() {
		return failed
	}
	return SkillDiscovery{Refreshed: matched, Discovered: &found, Errors: &errorCount}
}

func discoveryString(raw json.RawMessage) (string, bool) {
	var value string
	if !contracts.ValidUnicodeJSON(raw) || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func discoveryEnabled(candidate contracts.RawObject) bool {
	raw, supplied := candidate["enabled"]
	if !supplied {
		return true // Supported legacy omission; unknown explicit values are rejected.
	}
	var enabled bool
	return !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) && json.Unmarshal(raw, &enabled) == nil && enabled
}
