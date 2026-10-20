package app

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const maxToolText = work.MaxDeliveredTextUnits

func toolString(args contracts.RawObject, name string, required bool) (string, error) {
	value, err := httpapi.String(args, name, required)
	if err != nil || required && contracts.TrimText(value) == "" {
		return "", httpapi.Failure(400, "invalid_tool_arguments", "Invalid tool arguments.")
	}
	return value, nil
}

func toolFields(args contracts.RawObject, allowed ...string) bool {
	for key := range args {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}

func (app *WorkerApp) toolOwner(owner work.ToolContext) (work.ToolContext, error) {
	if !app.online() || owner.IsCurrent == nil || !owner.IsCurrent() {
		return owner, work.ErrStaleOwner
	}
	state := app.engine.Snapshot()
	if state.Takeover || state.Acquiring {
		return owner, work.ErrStaleOwner
	}
	if owner.CallID != "" && owner.TurnID == "" {
		if state.Call == nil || state.Call.Provider != "api" || state.Call.ID != owner.CallID {
			return owner, work.ErrStaleOwner
		}
		owner.ConversationID = app.store.ConversationID()
		owner.Owner = owner.CallID
	} else if !app.engine.Current(owner) {
		return owner, work.ErrStaleOwner
	}
	return owner, nil
}

func (app *WorkerApp) Execute(ctx context.Context, name string, args contracts.RawObject, input work.ToolContext) (json.RawMessage, error) {
	owner, err := app.toolOwner(input)
	if err != nil {
		return nil, err
	}
	var result json.RawMessage
	switch name {
	case "credential_find", "credential_get", "credential_store", "credential_request":
		result, err = app.credentialTool(ctx, name, args, owner)
	case "skill_list", "skill_get", "skill_save":
		result, err = app.skillTool(ctx, name, args, owner)
	case "schedule_list", "schedule_save", "schedule_delete":
		result, err = app.scheduleTool(ctx, name, args, owner)
	case "memory_write":
		if !toolFields(args, "file", "text") {
			return nil, errUnavailable
		}
		file, readErr := toolString(args, "file", false)
		if readErr != nil {
			return nil, readErr
		}
		if file == "" {
			file = "working-memory.md"
		}
		text, readErr := toolString(args, "text", true)
		if readErr != nil {
			return nil, readErr
		}
		result, err = app.saveOwnedNote(ctx, owner, file, text)
	case "send_message":
		text, readErr := toolString(args, "text", true)
		if readErr != nil || contracts.UTF16Length(text) > maxToolText {
			return nil, errUnavailable
		}
		if owner.CallID != "" && owner.TurnID == "" {
			var message *contracts.ChatMessage
			err = app.engine.ToolTransaction(ctx, owner, func(ctx context.Context) error {
				var err error
				message, err = app.store.Add(ctx, &contracts.ChatMessage{
					Role: contracts.RoleAssistant, Text: app.redactContext(ctx, text),
					Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
				})
				return err
			})
			if err == nil {
				result = encode(struct {
					Sent      bool   `json:"sent"`
					MessageID string `json:"messageId"`
				}{true, message.ID})
			}
		} else {
			result, err = app.engine.DeliverText(ctx, text, owner)
		}
	case "react_message":
		result, err = app.reactTool(ctx, args, owner)
	case "send_file", "create_voice_message":
		result, err = app.fileTool(ctx, name, args, owner)
	case "end_call":
		call := app.calls.Snapshot()
		if call != nil && owner.CallID != "" && call.ID == owner.CallID {
			err = app.calls.Stop(ctx, call.ID)
		}
		result = encode(struct {
			Ended bool `json:"ended"`
		}{true})
	default:
		return nil, httpapi.Failure(400, "unknown_tool", "Unknown tool.")
	}
	if err != nil {
		return nil, err
	}
	if name != "end_call" && (owner.IsCurrent == nil || !owner.IsCurrent()) {
		return nil, work.ErrStaleOwner
	}
	return result, nil
}

func (app *WorkerApp) credentialTool(ctx context.Context, name string, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
	switch name {
	case "credential_find":
		query, err := toolString(args, "query", false)
		if err != nil {
			return nil, err
		}
		items, err := app.credentials.Find(ctx, query)
		return encode(items), err
	case "credential_get":
		id, err := toolString(args, "id", true)
		if err != nil {
			return nil, err
		}
		item, err := app.credentials.Get(ctx, id)
		return encode(item), err
	case "credential_store":
		var input security.CredentialInput
		if err := json.Unmarshal(encode(args), &input); err != nil {
			return nil, err
		}
		var item security.CredentialMetadata
		err := app.engine.ToolTransaction(ctx, owner, func(ctx context.Context) error {
			var err error
			item, err = app.credentials.Upsert(ctx, input)
			return err
		})
		return encode(item), err
	default:
		if !toolFields(args, "name", "service", "reason") {
			return nil, errUnavailable
		}
		var input security.RequestInput
		if err := json.Unmarshal(encode(args), &input); err != nil {
			return nil, err
		}
		finish, err := app.engine.BeginCredentialWait(owner)
		if err != nil {
			return nil, err
		}
		defer finish()
		item, err := app.credentials.Request(ctx, input, owner.Owner, owner.IsCurrent)
		return encode(item), err
	}
}

func (app *WorkerApp) skillTool(ctx context.Context, name string, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
	switch name {
	case "skill_list":
		items, err := app.skills.List(ctx)
		return encode(struct {
			Skills []skills.Summary `json:"skills"`
		}{items}), err
	case "skill_get":
		name, err := toolString(args, "name", true)
		if err != nil {
			return nil, err
		}
		item, err := app.skills.Get(ctx, name)
		return encode(item), err
	default:
		input, err := skills.DecodeSave(encode(args))
		if err != nil {
			return nil, err
		}
		var item skills.View
		err = app.engine.ToolTransaction(ctx, owner, func(ctx context.Context) error {
			var err error
			item, err = app.skills.Save(ctx, input, true)
			return err
		})
		if err != nil {
			return nil, err
		}
		app.engine.InvalidateContext()
		// Discovery is independent of the committed file write. A failed refresh
		// must not pretend the skill was discovered or its helpers were tested.
		discovery := app.refreshSkills(ctx, owner, item)
		return encode(struct {
			Saved         bool           `json:"saved"`
			Skill         skills.View    `json:"skill"`
			Discovery     SkillDiscovery `json:"discovery"`
			HelpersTested bool           `json:"helpersTested"`
		}{true, item, discovery, false}), nil
	}
}

func (app *WorkerApp) scheduleTool(ctx context.Context, name string, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
	authorize := func(ctx context.Context, commit func(context.Context) error) error {
		return app.engine.ToolTransaction(ctx, owner, commit)
	}
	switch name {
	case "schedule_list":
		if len(args) != 0 {
			return nil, errUnavailable
		}
		result, err := app.scheduler.List(ctx)
		return encode(result), err
	case "schedule_delete":
		if !toolFields(args, "id") {
			return nil, errUnavailable
		}
		id, err := toolString(args, "id", true)
		if err != nil {
			return nil, err
		}
		return app.scheduler.RemoveAuthorized(ctx, id, authorize)
	default:
		item, err := app.scheduler.SaveAuthorized(ctx, encode(args), false, authorize)
		return encode(struct {
			Saved bool            `json:"saved"`
			Item  json.RawMessage `json:"item"`
			Now   string          `json:"now"`
		}{err == nil, item, time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}), err
	}
}

func (app *WorkerApp) reactTool(ctx context.Context, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
	if !toolFields(args, "messageId", "emoji") {
		return nil, errUnavailable
	}
	id, err := toolString(args, "messageId", true)
	if err != nil {
		return nil, err
	}
	var emoji contracts.Optional[string]
	if len(args["emoji"]) == 0 || json.Unmarshal(args["emoji"], &emoji) != nil {
		return nil, errUnavailable
	}
	message, err := app.store.Message(id)
	if err != nil || message.Role != contracts.RoleUser {
		return nil, errUnavailable
	}
	historyService := history.New(app.store, app.engine.HistoryTransaction)
	var changed bool
	err = app.engine.ToolTransaction(ctx, owner, func(ctx context.Context) error {
		var err error
		changed, err = historyService.SetAssistantReaction(ctx, id, owner.ConversationID, emoji)
		return err
	})
	app.change()
	return encode(struct {
		Reacted   bool                       `json:"reacted"`
		MessageID string                     `json:"messageId"`
		Emoji     contracts.Optional[string] `json:"emoji"`
		Changed   bool                       `json:"changed"`
	}{err == nil, id, emoji, changed}), err
}

func (app *WorkerApp) fileTool(ctx context.Context, name string, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
	if owner.TurnID == "" {
		return nil, work.ErrStaleOwner
	}
	output := filepath.Join(app.options.Startup.WorkspaceRoot, owner.ConversationID, "output")
	path := ""
	if name == "create_voice_message" {
		text, err := toolString(args, "text", true)
		if err != nil || contracts.UTF16Length(text) > maxToolText {
			return nil, errUnavailable
		}
		voiceName, err := toolString(args, "voice", false)
		if err != nil {
			return nil, err
		}
		file, err := app.worker.CreateVoiceMessage(ctx, workerRuntime.VoiceMessageOptions{
			Text: text, OutputDirectory: output, Voice: voiceName,
			Language: app.store.Snapshot().Settings.Language,
		})
		if err != nil {
			return nil, err
		}
		path = file.Path
	} else {
		var err error
		path, err = toolString(args, "path", true)
		if err != nil {
			return nil, err
		}
	}
	if !owner.IsCurrent() {
		return nil, work.ErrStaleOwner
	}
	attachments, err := app.deliverables.ArchiveExplicit(ctx, files.ArchiveInput{
		OutputDirectory: output, ExplicitPaths: []string{path}, OnlyExplicit: true,
		IsCurrent: owner.IsCurrent,
	})
	if err != nil {
		return nil, err
	}
	return app.engine.DeliverAttachments(ctx, attachments, owner)
}

func (app *WorkerApp) saveOwnedNote(ctx context.Context, owner work.ToolContext, name, text string) (json.RawMessage, error) {
	return app.writeNote(ctx, owner.ConversationID, name, text, func(operation func(context.Context) error) error {
		return app.engine.ToolTransaction(ctx, owner, operation)
	})
}

func (app *WorkerApp) saveNote(ctx context.Context, name, text string) (json.RawMessage, error) {
	conversationID := app.store.ConversationID()
	return app.writeNote(ctx, conversationID, name, text, func(operation func(context.Context) error) error {
		return app.engine.ConversationTransaction(ctx, conversationID, operation)
	})
}

func (app *WorkerApp) writeNote(ctx context.Context, conversationID, name, text string, transaction func(func(context.Context) error) error) (json.RawMessage, error) {
	contains, err := app.vault.ContainsSecret(ctx, text)
	if err != nil || contains {
		return nil, security.ErrCredentialInactive
	}
	var projectionErr error
	err = transaction(func(ctx context.Context) error {
		if err := app.memory.WriteNote(ctx, name, text); err != nil {
			return err
		}

		// SQLite is authoritative. The legacy state field is only a projection;
		// its failure must not report a committed memory write as unsaved.
		working, err := app.memory.ReadNote(ctx, "working-memory.md")
		if err != nil {
			projectionErr = err
			return nil
		}
		projectionErr = app.store.Mutate(ctx, func(state *contracts.State) error {
			if state.ConversationID != conversationID {
				return store.ErrMessageConflict
			}
			state.Memory = working
			return nil
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if projectionErr != nil {
		app.diagnostics.Log("memory.projection", diagnostics.Fields{Code: "MEMORY_PROJECTION_FAILED"})
	}

	if err = app.memoryChanged(ctx); err != nil {
		return nil, err
	}
	return encode(struct {
		Saved bool   `json:"saved"`
		File  string `json:"file"`
	}{true, name}), nil
}

func (app *WorkerApp) memoryChanged(ctx context.Context) error {
	app.engine.InvalidateContext()
	app.change()
	call := app.calls.Snapshot()
	if call == nil {
		return nil
	}
	text, err := app.memory.Context(ctx, false)
	if err != nil {
		app.memoryContextUnconfirmed()
		return nil
	}
	outcome := app.calls.SyncMemory(ctx, call.ID, app.redact(text))
	if outcome.Status != contracts.LiveContextStatusSubmitted && outcome.Status != contracts.LiveContextStatusSuperseded {
		app.memoryContextUnconfirmed()
	}
	return nil
}

func (app *WorkerApp) memoryContextUnconfirmed() {
	app.diagnostics.Log("memory.context", diagnostics.Fields{Code: "MEMORY_CALL_CONTEXT_UNCONFIRMED"})
	app.notice("Memory was saved, but the active call could not confirm its context update.")
}
