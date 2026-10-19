package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

func (app *App) syncPreferences(ctx context.Context) error {
	app.preferenceMu.Lock()
	defer app.preferenceMu.Unlock()
	if app.bridge.Status() != contracts.ConnectionStatusOnline {
		return nil
	}
	generation := app.bridge.Generation()
	binding := app.bindingIdentity()
	app.mu.Lock()
	configuration := app.configuration
	app.mu.Unlock()
	state := app.bridge.Snapshot()
	var capabilities struct {
		Languages []string `json:"languages"`
	}
	_ = json.Unmarshal(state.Extra["capabilities"], &capabilities)
	language := i18n.ForWorker(configuration.Language, capabilities.Languages)
	values := struct {
		Language string `json:"language"`
		TimeZone string `json:"timeZone,omitempty"`
	}{language, app.options.TimeZone}
	if state.Settings.Language == values.Language && (values.TimeZone == "" || state.Settings.TimeZone == values.TimeZone) {
		return nil
	}
	raw, _ := json.Marshal(values)
	response, err := app.bridge.Request(ctx, http.MethodPatch, "/api/settings", http.Header{"Content-Type": []string{"application/json"}}, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if generation != app.bridge.Generation() || binding != app.bindingIdentity() {
		return computer.ErrBridgeChanged
	}

	if response.StatusCode != http.StatusOK {
		return computer.ErrSessionUnavailable
	}
	_, err = app.bridge.Refresh(ctx)
	return err
}
