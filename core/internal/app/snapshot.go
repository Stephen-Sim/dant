package app

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type workerCapabilities struct {
	WorkReply          bool     `json:"workReply"`
	TaskReopen         bool     `json:"taskReopen"`
	RecurringSchedules bool     `json:"recurringSchedules"`
	Backups            bool     `json:"backups"`
	Languages          []string `json:"languages"`
}

func (app *WorkerApp) Snapshot(ctx context.Context) (contracts.WorkerSnapshot, error) {
	state, execution := app.engine.StateSnapshot()
	worker := app.worker.Snapshot()
	notes, err := app.memory.Notes(ctx)
	if err != nil {
		return contracts.WorkerSnapshot{}, err
	}
	workingMemory := ""
	for _, note := range notes {
		if note.Name == "working-memory.md" {
			workingMemory = note.Text
			break
		}
	}
	languages, err := i18n.Languages()
	if err != nil {
		return contracts.WorkerSnapshot{}, err
	}
	codes := make([]string, 0, len(languages))
	for _, language := range languages {
		codes = append(codes, language.Code)
	}
	key, err := app.voiceKeys.Status()
	if err != nil {
		return contracts.WorkerSnapshot{}, err
	}
	app.callCaptions.Sync(execution.Call, state.ConversationID, app.online())
	control := app.computer.Snapshot()
	native := app.nativeVoice.Snapshot()
	available := worker.Status == contracts.ConnectionStatusOnline
	var reason *string
	if !available {
		text := "vm-offline"
		reason = &text
	}
	worker.Realtime = contracts.RawObject{
		"available": encode(available), "reason": encode(reason),
		"provider": encode("subscription"), "billing": encode("subscription"),
		"subscription": encode(struct {
			Available bool            `json:"available"`
			Version   string          `json:"version"`
			Error     *string         `json:"error"`
			LastStop  json.RawMessage `json:"lastStop"`
		}{available, "v3", native.Error, nil}),
		"api": encode(struct {
			Available bool   `json:"available"`
			Billing   string `json:"billing"`
		}{key.Configured, "api"}),
		"key": encode(key),
	}
	if inner, err := contracts.DecodeObject(worker.Account["account"], len(worker.Account["account"])); err == nil {
		worker.Account = inner
	} else {
		worker.Account = nil
	}
	if len(worker.Models) == 0 {
		worker.Models = json.RawMessage(`[]`)
	}
	result := contracts.WorkerSnapshot{
		Mode: "vm-worker", ConversationID: state.ConversationID,
		Messages: state.Messages, Completions: state.Completions,
		WorkTasks: work.TaskContextSnapshots(state.WorkTasks), Settings: state.Settings,
		Worker: worker, Active: execution.Active, Queue: execution.Queue,
		Call: execution.Call, Takeover: control.Status == contracts.ComputerControlStatusHuman,
		Acquiring: execution.Acquiring, Executor: execution.Executor,
		Extra: contracts.RawObject{
			"capabilities": encode(workerCapabilities{true, true, true, true, codes}),
			"presence":     encode(state.Presence),
			"credentials":  encode(app.credentials.Snapshot(ctx)),
			"skills":       encode(app.skills.Snapshot(ctx)),
			"memory":       encode(workingMemory), "memoryFiles": encode(notes),
			"usage":       encode(app.usage.Snapshot()),
			"telegram":    encode(app.telegram.Status()),
			"computer":    encode(control),
			"callCaption": encode(app.callCaptions.Snapshot()),
			"schedules":   encode(state.Schedules),
			"provisioning": encode(struct {
				Status contracts.ProvisioningStatus `json:"status"`
			}{contracts.ProvisioningStatusIdle}),
		},
	}
	// A history clear can finish while independent read-only feature projections
	// are being assembled. Never publish those projections into a new chat.
	if app.store.ConversationID() != state.ConversationID {
		return contracts.WorkerSnapshot{}, errUnavailable
	}
	return result, nil
}
