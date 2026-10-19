package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/settings"
)

const controllerConfigLimit = 64 * 1024
const controllerCacheLimit = 128 * 1024 * 1024

type Configuration struct {
	settings.Appearance
	Language             string              `json:"language"`
	Notifications        bool                `json:"notifications"`
	ShowWorkSummary      bool                `json:"showWorkSummary"`
	ShowCallCaptions     bool                `json:"showCallCaptions"`
	ServiceUpdatesPaused bool                `json:"serviceUpdatesPaused"`
	Extra                contracts.RawObject `json:"-"`
}

func defaultConfiguration() Configuration {
	return Configuration{Appearance: settings.AppearanceDefaults(), Language: "zh", ShowCallCaptions: true, Extra: contracts.RawObject{}}
}

func readConfiguration(dataDir string) Configuration {
	configuration := defaultConfiguration()
	raw, err := files.ReadRegular(filepath.Join(dataDir, "controller.json"), controllerConfigLimit)
	if err != nil {
		return configuration
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	object, err := contracts.DecodeObject(raw, controllerConfigLimit)
	if err != nil {
		return configuration
	}
	configuration.Appearance = settings.ReadAppearance(raw)
	for _, key := range []string{"language", "notifications", "showWorkSummary", "showCallCaptions", "serviceUpdatesPaused"} {
		switch key {
		case "language":
			var value string
			if json.Unmarshal(object[key], &value) == nil {
				configuration.Language = i18n.Normalize(value, "zh")
			}
		case "notifications":
			_ = json.Unmarshal(object[key], &configuration.Notifications)
		case "showWorkSummary":
			_ = json.Unmarshal(object[key], &configuration.ShowWorkSummary)
		case "showCallCaptions":
			if !bytes.Equal(bytes.TrimSpace(object[key]), []byte("null")) {
				_ = json.Unmarshal(object[key], &configuration.ShowCallCaptions)
			}
		case "serviceUpdatesPaused":
			_ = json.Unmarshal(object[key], &configuration.ServiceUpdatesPaused)
		}
	}
	appearanceRaw, _ := json.Marshal(configuration.Appearance)
	appearance, _ := contracts.DecodeObject(appearanceRaw, controllerConfigLimit)
	for key, raw := range object {
		if _, known := appearance[key]; known {
			continue
		}
		switch key {
		case "language", "notifications", "showWorkSummary", "showCallCaptions", "serviceUpdatesPaused":
		default:
			configuration.Extra[key] = append(json.RawMessage{}, raw...)
		}
	}

	return configuration
}

func (configuration Configuration) MarshalJSON() ([]byte, error) {
	type plain Configuration
	raw, err := json.Marshal(plain(configuration))
	if err != nil {
		return nil, err
	}
	object, err := contracts.DecodeObject(raw, controllerConfigLimit)
	if err != nil {
		return nil, err
	}
	for key, value := range configuration.Extra {
		if _, known := object[key]; !known {
			object[key] = value
		}
	}

	return json.Marshal(object)
}

func (app *App) persistConfiguration(ctx context.Context, value Configuration) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}

	if err := files.WriteAtomic(ctx, filepath.Join(app.options.DataDir, "controller.json"), raw, 0600); err != nil {
		return err
	}
	app.mu.Lock()
	app.configuration = value
	app.mu.Unlock()
	return nil
}

func readCached(dataDir string) contracts.WorkerSnapshot {
	raw, err := files.ReadRegular(filepath.Join(dataDir, "state-cache.json"), controllerCacheLimit)
	if err != nil {
		return emptyWorkerSnapshot()
	}

	if _, err := contracts.DecodeObject(raw, controllerCacheLimit); err != nil {
		return emptyWorkerSnapshot()
	}
	var state contracts.WorkerSnapshot
	if json.Unmarshal(raw, &state) != nil {
		return emptyWorkerSnapshot()
	}
	delete(state.Extra, "callCaption")
	return state
}

func emptyWorkerSnapshot() contracts.WorkerSnapshot {
	return contracts.WorkerSnapshot{
		Messages:    []*contracts.ChatMessage{},
		Completions: []contracts.Completion{},
		WorkTasks:   []contracts.WorkRecord{},
		Queue:       []string{},
		Worker: contracts.WorkerState{
			Status: contracts.ConnectionStatusOffline,
			Models: json.RawMessage("[]"),
			Realtime: contracts.RawObject{
				"available": json.RawMessage("false"),
				"reason":    json.RawMessage(`"vm-offline"`),
				"key":       json.RawMessage(`{"configured":false}`),
			},
		},
		Settings: contracts.Settings{
			Language: "zh", Voice: "marin", ShowCallCaptions: true,
			VM: contracts.VMSettings{User: "dant", Port: 22},
		},
		Extra: contracts.RawObject{
			"schedules": json.RawMessage("[]"),
			"memory":    json.RawMessage(`""`),
		},
	}
}

func (app *App) saveCache(state contracts.WorkerSnapshot) {
	delete(state.Extra, "callCaption")
	raw, err := json.Marshal(state)
	if err != nil || len(raw) > controllerCacheLimit {
		return
	}
	bounded, stop := context.WithTimeout(app.ctx, cacheWriteTimeout)
	defer stop()
	if files.WriteAtomic(bounded, filepath.Join(app.options.DataDir, "state-cache.json"), raw, 0600) == nil {
		app.mu.Lock()
		app.lastSaved = app.options.Now().UnixMilli()
		app.mu.Unlock()
	}
}
