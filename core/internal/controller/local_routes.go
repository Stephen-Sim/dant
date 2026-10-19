package controller

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/settings"
)

func (app *App) desktopRoute(writer http.ResponseWriter, request *http.Request) error {
	_, object, err := jsonRequest(request)
	if err != nil {
		return err
	}
	reason := "exit"
	if raw, exists := object["reason"]; exists {
		if json.Unmarshal(raw, &reason) != nil || (reason != "exit" && reason != "install") {
			return computer.ErrBinding
		}
	}
	var leaseID string
	if raw, exists := object["leaseId"]; exists {
		if json.Unmarshal(raw, &leaseID) != nil || leaseID == "" {
			return computer.ErrBinding
		}
	}

	if !onlyFields(object, "reason", "leaseId") {
		return computer.ErrBinding
	}
	switch request.URL.Path {
	case "/api/desktop/exit":
		if app.backups.Busy() {
			return backups.ErrBusy
		}
		if reason == "install" {
			if _, err := app.lease.Pin(leaseID); err != nil {
				return err
			}
		} else {
			if leaseID != "" {
				return computer.ErrBinding
			}
			if err := app.lease.AssertQuiescent(0); err != nil {
				return err
			}
		}
		result, err := app.desktop.Exit(request.Context())
		if err != nil {
			if reason == "install" {
				_ = app.lease.Release(leaseID)
			}
			return err
		}
		if reason == "install" {
			lease, err := app.lease.Renew(leaseID)
			if err != nil {
				return err
			}
			writeJSON(writer, 200, struct {
				DesktopResult
				LeaseID   string `json:"leaseId"`
				ExpiresAt int64  `json:"expiresAt"`
			}{result, lease.LeaseID, lease.ExpiresAt})
		} else {
			writeJSON(writer, 200, result)
		}
		return nil
	case "/api/desktop/cancel-exit":
		lease := app.lease.Current()
		if lease != nil {
			if reason != "install" || lease.LeaseID != leaseID {
				return ErrDesktopBusy
			}
		} else if leaseID != "" {
			return ErrDesktopBusy
		}
		result, err := app.cancelDesktopTransition(request.Context())
		if err != nil {
			return err
		}
		if leaseID != "" {
			if err := app.lease.Release(leaseID); err != nil {
				return err
			}
		}
		writeJSON(writer, 200, result)
		return nil
	case "/api/desktop/open":
		if len(object) != 0 {
			return computer.ErrBinding
		}
		if err := app.lease.AssertQuiescent(0); err != nil {
			return err
		}
		if app.desktop.Blocked() {
			if _, err := app.cancelDesktopTransition(request.Context()); err != nil {
				return err
			}
		}
		writeJSON(writer, 200, struct {
			OK bool `json:"ok"`
		}{true})
		return nil
	default:
		return apiError(404, "not_found", "The endpoint was not found.")
	}
}

func (app *App) importProfile(writer http.ResponseWriter, request *http.Request) error {
	_, object, err := jsonRequest(request)
	if err != nil {
		return err
	}

	if !onlyFields(object, "id", "directory", "replaceCurrent", "skipBackupOnce") {
		return computer.ErrBinding
	}
	skip := false
	if raw, exists := object["skipBackupOnce"]; exists {
		if string(bytes.TrimSpace(raw)) != "true" {
			return computer.ErrBinding
		}
		skip = true
	}

	if app.backups.Busy() {
		return backups.ErrBusy
	}

	if !skip {
		if err := app.backups.BeforeVMChange(request.Context()); err != nil {
			return err
		}
	}
	state := app.bridge.Snapshot()
	if app.bridge.Status() == contracts.ConnectionStatusOnline && !computer.ServiceUpdateQuiescent(state, true) {
		return computer.ErrPauseUnconfirmed
	}
	delete(object, "skipBackupOnce")
	raw, _ := json.Marshal(object)
	var selection computer.ProfileImport
	if json.Unmarshal(raw, &selection) != nil {
		return computer.ErrBinding
	}
	before := app.bindingIdentity()
	result, err := app.profiles.Import(request.Context(), selection)
	if err != nil {
		return err
	}

	if before != app.bindingIdentity() {
		app.bridge.Disconnect()
	}
	app.mu.Lock()
	app.profileError = nil
	app.mu.Unlock()
	app.broadcastState()
	writeJSON(writer, 200, result)
	return nil
}

func (app *App) patchSettings(writer http.ResponseWriter, request *http.Request) error {
	raw, object, err := jsonRequest(request)
	if err != nil {
		return err
	}
	appearance, err := settings.ValidateAppearancePatch(raw)
	if err != nil {
		return err
	}
	app.configurationMu.Lock()
	defer app.configurationMu.Unlock()
	app.mu.Lock()
	configuration := app.configuration
	app.mu.Unlock()
	configRaw, _ := json.Marshal(configuration)
	configFields, _ := contracts.DecodeObject(configRaw, controllerConfigLimit)
	for key, value := range appearance {
		configFields[key] = value
		delete(object, key)
	}

	if value, exists := object["language"]; exists {
		var language string
		if json.Unmarshal(value, &language) != nil || !i18n.IsLanguage(language) {
			return computer.ErrBinding
		}
		configFields["language"] = value
		delete(object, "language")
	}
	for _, key := range []string{"notifications", "showWorkSummary", "showCallCaptions"} {
		if value, exists := object[key]; exists {
			if !bytes.Equal(bytes.TrimSpace(value), []byte("true")) && !bytes.Equal(bytes.TrimSpace(value), []byte("false")) {
				return computer.ErrBinding
			}
			configFields[key] = value
			delete(object, key)
		}
	}
	skip := false
	if value, exists := object["skipBackupOnce"]; exists {
		if !bytes.Equal(bytes.TrimSpace(value), []byte("true")) || object["vm"] == nil {
			return computer.ErrBinding
		}
		skip = true
		delete(object, "skipBackupOnce")
	}

	if value, exists := object["vm"]; exists {
		if app.backups.Busy() {
			return backups.ErrBusy
		}
		if app.bridge.Status() == contracts.ConnectionStatusOnline && !computer.ServiceUpdateQuiescent(app.bridge.Snapshot(), true) {
			return computer.ErrPauseUnconfirmed
		}
		patch, err := contracts.DecodeObject(value, controllerConfigLimit)
		if err != nil {
			return computer.ErrBinding
		}
		old, err := computer.ReadBinding(app.options.DataDir)
		base := contracts.RawObject{}
		if err == nil {
			oldRaw, _ := json.Marshal(old)
			base, _ = contracts.DecodeObject(oldRaw, controllerConfigLimit)
		}
		for _, key := range []string{"host", "user", "port", "keyPath", "knownHosts"} {
			if raw, exists := patch[key]; exists {
				base[key] = raw
			}
		}
		merged, _ := json.Marshal(base)
		binding, err := computer.NormalizeBinding(merged, app.options.DataDir)
		if err != nil {
			return err
		}
		if !skip {
			if err := app.backups.BeforeVMChange(request.Context()); err != nil {
				return err
			}
		}
		data, _ := json.Marshal(binding)
		if err := files.WriteAtomic(request.Context(), filepath.Join(app.options.DataDir, "vm.json"), data, 0600); err != nil {
			return err
		}
		_ = app.profiles.RegisterCurrent(request.Context())
		app.bridge.Disconnect()
		delete(object, "vm")
	}
	configRaw, _ = json.Marshal(configFields)
	var next Configuration
	if json.Unmarshal(configRaw, &next) != nil {
		return computer.ErrBinding
	}
	next.Extra = configuration.Extra
	if err := app.persistConfiguration(request.Context(), next); err != nil {
		return err
	}

	if err := app.notifications.Configure(request.Context(), next.Notifications); err != nil {
		return err
	}
	app.broadcastState()
	if err := app.syncPreferences(request.Context()); err != nil {
		return err
	}

	if len(object) > 0 {
		data, _ := json.Marshal(object)
		request.Body = io.NopCloser(bytes.NewReader(data))
		request.Header.Set("Content-Type", "application/json")
		return app.proxy(writer, request)
	}
	writeJSON(writer, 200, struct {
		OK bool `json:"ok"`
	}{true})
	return nil
}

type transferWriter struct {
	http.ResponseWriter
	started bool
}

func (writer *transferWriter) Write(raw []byte) (int, error) {
	writer.started = true
	return writer.ResponseWriter.Write(raw)
}

func (app *App) backupRoute(writer http.ResponseWriter, request *http.Request) error {
	path := request.URL.Path
	method := request.Method
	ctx := request.Context()
	if path == "/api/backups" && method == http.MethodGet {
		status, err := app.backups.Status(ctx)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, status)
		return nil
	}

	if path == "/api/backups/settings" && method == http.MethodPatch {
		raw, _, err := jsonRequest(request)
		if err != nil {
			return err
		}
		if err := app.backups.Configure(ctx, raw); err != nil {
			return err
		}
		status, err := app.backups.Status(ctx)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, status)
		return nil
	}

	if path == "/api/backups/run" && method == http.MethodPost {
		if err := app.backups.Run(); err != nil {
			return err
		}
		writeJSON(writer, 202, struct {
			Started bool `json:"started"`
		}{true})
		return nil
	}

	if path == "/api/backups/import" && method == http.MethodPost {
		kind, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if kind != "application/octet-stream" || request.ContentLength > backups.PortableMaxFileBytes {
			return backups.ErrInvalid
		}
		passphrase, err := importPassphrase(request.Header.Get("X-Dant-Backup-Passphrase"))
		if err != nil {
			return err
		}
		backup, err := app.backups.ImportPortable(ctx, io.LimitReader(request.Body, backups.PortableMaxFileBytes+1), passphrase)
		if err != nil {
			return err
		}
		writeJSON(writer, 201, struct {
			Backup backups.Metadata `json:"backup"`
		}{backup})
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/backups/"), "/")
	if len(parts) != 2 || method != http.MethodPost {
		return apiError(404, "not_found", "The backup endpoint was not found.")
	}
	id, action := parts[0], parts[1]
	switch action {
	case "preview":
		preview, err := app.backups.PreviewRestore(ctx, id)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, preview)
		return nil
	case "restore":
		_, object, err := jsonRequest(request)
		if err != nil {
			return err
		}
		confirmation, err := requiredString(object, "confirmation")
		if err != nil {
			return err
		}
		if err := app.backups.Restore(id, confirmation); err != nil {
			return err
		}
		writeJSON(writer, 202, struct {
			Started bool `json:"started"`
		}{true})
		return nil
	case "export":
		_, object, err := jsonRequest(request)
		if err != nil || !onlyFields(object, "passphrase") {
			return backups.ErrInvalid
		}
		passphrase, err := requiredString(object, "passphrase")
		if err != nil {
			return err
		}
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "application/octet-stream")
		writer.Header().Set("Content-Disposition", `attachment; filename="dant-backup-`+id+`.dant"`)
		output := &transferWriter{ResponseWriter: writer}
		if err := app.backups.ExportPortable(ctx, id, passphrase, output); err != nil {
			if output.started {
				panic(http.ErrAbortHandler)
			}
			return err
		}
		return nil
	default:
		return apiError(404, "not_found", "The backup endpoint was not found.")
	}
}

func (app *App) diagnosticsRoute(writer http.ResponseWriter, request *http.Request) error {
	if request.Method != http.MethodGet {
		return apiError(405, "method_not_allowed", "Diagnostics are read-only.")
	}
	worker := struct {
		Available bool              `json:"available"`
		Reason    string            `json:"reason,omitempty"`
		Status    json.RawMessage   `json:"status,omitempty"`
		Recent    []json.RawMessage `json:"recent,omitempty"`
	}{Reason: "worker-unavailable"}
	if app.bridge.Status() == contracts.ConnectionStatusOnline {
		response, err := app.bridge.Request(request.Context(), http.MethodGet, "/api/diagnostics", nil, nil)
		if err == nil {
			defer response.Body.Close()
			raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
			if err == nil && len(raw) <= 1024*1024 {
				object, err := contracts.DecodeObject(raw, 1024*1024)
				if err == nil {
					status, err := contracts.DecodeObject(object["status"], 1024*1024)
					var recent []json.RawMessage
					if err == nil && status != nil && json.Unmarshal(object["recent"], &recent) == nil {
						if len(recent) > 50 {
							recent = recent[len(recent)-50:]
						}
						worker.Available = true
						worker.Reason = ""
						worker.Status = object["status"]
						worker.Recent = recent
					}
				}
			}
		}
	}
	recent, err := app.diagnostics.Recent(request.Context(), 50)
	if err != nil {
		return err
	}
	writeJSON(writer, 200, struct {
		Status diagnostics.Status   `json:"status"`
		Recent []diagnostics.Record `json:"recent"`
		Worker any                  `json:"worker"`
	}{app.diagnostics.Status(), recent, worker})
	return nil
}
