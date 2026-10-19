package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func apiError(status int, code, message string) error {
	return &contracts.APIError{Status: status, Code: code, Message: message}
}

func writeError(writer http.ResponseWriter, err error) {
	status, code, message := http.StatusBadGateway, "request_failed", "The request could not be completed. Check the connection and its current state."
	var api *contracts.APIError
	var update *updates.Error
	if errors.As(err, &api) {
		status, code, message = api.Status, api.Code, api.Message
	} else if errors.As(err, &update) {
		status, code, message = update.Status, update.Code, update.Message
	} else {
		switch {
		case errors.Is(err, computer.ErrBinding), errors.Is(err, backups.ErrInvalid), errors.Is(err, security.ErrAPIKey):
			status, code, message = 400, "invalid_request", "Check the request values and try again."
		case errors.Is(err, ErrDesktopBusy), errors.Is(err, updates.ErrInstallationDeferred):
			status, code, message = 409, "desktop_transition_busy", "Work is paused for an update or exit."
		case errors.Is(err, backups.ErrBusy), errors.Is(err, backups.ErrRunning):
			status, code, message = 409, "backup_running", "A backup operation is already running."
		case errors.Is(err, backups.ErrRestoreUnconfirmed):
			status, code, message = 409, "backup_restore_unconfirmed", "The restore outcome is not confirmed. Check its status before continuing."
		case errors.Is(err, backups.ErrBeforeVMChange):
			status, code, message = 409, "backup_before_vm_change_required", "A backup is required before changing this computer."
		case errors.Is(err, computer.ErrBridgeOffline):
			status, code, message = 503, "vm_offline", "The work computer is offline. Reconnect before continuing."
		case errors.Is(err, context.Canceled):
			status, code, message = 499, "request_cancelled", "The request was cancelled."
		case errors.Is(err, context.DeadlineExceeded):
			status, code, message = 504, "request_timeout", "The request timed out. Check its current state before trying again."
		}
	}
	writeJSON(writer, status, struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{message, code})
}

func jsonRequest(request *http.Request) ([]byte, contracts.RawObject, error) {
	raw, err := io.ReadAll(io.LimitReader(request.Body, config.APIJSONBodyBytes+1))
	if err != nil || len(raw) > config.APIJSONBodyBytes {
		return nil, nil, apiError(413, "request_too_large", "The request is too large.")
	}
	object, err := contracts.DecodeObject(raw, config.APIJSONBodyBytes)
	if err != nil {
		return nil, nil, apiError(400, "invalid_request", "An object request is required.")
	}

	return raw, object, nil
}

func onlyFields(object contracts.RawObject, keys ...string) bool {
	for key := range object {
		found := false
		for _, allowed := range keys {
			if key == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	return true
}

func requiredString(object contracts.RawObject, key string) (string, error) {
	var value string
	if json.Unmarshal(object[key], &value) != nil || value == "" {
		return "", computer.ErrBinding
	}

	return value, nil
}

func (app *App) serve(writer http.ResponseWriter, request *http.Request) {
	owner, cancel := context.WithCancel(request.Context())
	body := request.Body
	responseControl := http.NewResponseController(writer)
	stop := context.AfterFunc(app.ctx, func() {
		cancel()
		_ = responseControl.SetReadDeadline(time.Now())
		_ = responseControl.SetWriteDeadline(time.Now())
		if body != nil {
			_ = body.Close()
		}
	})
	defer func() {
		stop()
		cancel()
	}()
	request = request.WithContext(owner)
	app.mu.Lock()
	closed := app.closed
	app.mu.Unlock()
	if closed {
		writeError(writer, apiError(503, "controller_closed", "The application is closing."))
		return
	}
	path := request.URL.Path
	if app.diagnostics != nil {
		app.diagnostics.Log("http.request", diagnostics.Fields{Method: request.Method, Route: path})
	}

	if path == "/events" {
		if request.Method != http.MethodGet {
			writer.WriteHeader(405)
			return
		}
		app.serveWebSocket(writer, request)
		return
	}

	if path == "/api/session" && request.Method == http.MethodGet {
		app.auth.ServeSession(writer, request)
		return
	}

	if strings.HasPrefix(path, "/api/internal") {
		writer.WriteHeader(http.StatusForbidden)
		return
	}

	if !strings.HasPrefix(path, "/api/") {
		app.serveStatic(writer, request)
		return
	}

	if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
		if app.backups.Phase() == contracts.BackupPhaseRestoring || app.backups.Phase() == contracts.BackupPhaseUnknown {
			writeError(writer, backups.ErrRestoreUnconfirmed)
			return
		}
		if app.desktop.Blocked() && !strings.HasPrefix(path, "/api/desktop/") && !strings.HasPrefix(path, "/api/updates/") {
			writeError(writer, ErrDesktopBusy)
			return
		}
	}
	var finish func(bool)
	sensitive, err := updates.UpdateSensitiveRequest(request.Method, request.URL.RequestURI())
	if err != nil {
		writeError(writer, err)
		return
	}

	if sensitive {
		finish, err = app.lease.Enter()
		if err != nil {
			writeError(writer, err)
			return
		}
		defer func() { finish(false) }()
	}
	err = app.route(writer, request)
	if err != nil {
		var unknown *computer.RequestError
		if finish != nil && errors.As(err, &unknown) {
			finish(unknown.UnknownOutcome)
		}
		writeError(writer, err)
	}
}

func (app *App) route(writer http.ResponseWriter, request *http.Request) error {
	path := request.URL.Path
	method := request.Method
	ctx := request.Context()
	switch {
	case path == "/api/events" && method == http.MethodGet:
		app.serveSSE(writer, request)
		return nil
	case path == "/api/state" && method == http.MethodGet:
		if app.bridge.Status() == contracts.ConnectionStatusOnline {
			_, _ = app.bridge.Refresh(ctx)
		}
		writeJSON(writer, 200, app.Snapshot())
		return nil
	case (path == "/api/version" || path == "/api/updates"):
		if method != http.MethodGet {
			return apiError(405, "method_not_allowed", "This endpoint is read-only.")
		}
		if path == "/api/version" {
			writeJSON(writer, 200, app.updates.Info())
			return nil
		}
		channel := request.URL.Query().Get("channel")
		if channel == "" {
			channel = "stable"
		}
		result, err := app.updates.Check(ctx, channel)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, result)
		return nil
	case path == "/api/updates/install-lease" && method == http.MethodPost:
		raw, object, err := jsonRequest(request)
		if err != nil {
			return err
		}
		_ = raw
		if len(object) != 0 {
			return computer.ErrBinding
		}
		receipt, err := app.lease.Acquire(ctx)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, receipt)
		return nil
	case strings.HasPrefix(path, "/api/updates/install-lease/") && method == http.MethodDelete:
		if err := app.lease.Release(strings.TrimPrefix(path, "/api/updates/install-lease/")); err != nil {
			return err
		}
		writeJSON(writer, 200, struct {
			OK bool `json:"ok"`
		}{true})
		return nil
	case path == "/api/controller/settings" && method == http.MethodGet:
		app.mu.Lock()
		configuration := app.configuration
		app.mu.Unlock()
		binding, _ := computer.ReadBinding(app.options.DataDir)
		if binding.User == "" {
			binding.User = "dant"
			binding.Port = 22
		}
		providers, _ := app.provisioning.Providers(ctx)
		var deployment *computer.DeploymentStatus
		if app.deployer != nil {
			status := app.deployer.Status()
			deployment = &status
		}
		writeJSON(writer, 200, struct {
			Version       string                     `json:"version"`
			Language      string                     `json:"language"`
			VM            computer.Binding           `json:"vm"`
			Status        contracts.ConnectionStatus `json:"status"`
			ServiceUpdate *computer.DeploymentStatus `json:"serviceUpdate"`
			UpdatesPaused bool                       `json:"updatesPaused"`
			Profiles      computer.ProfileDiscovery  `json:"profiles"`
			Providers     computer.ProviderInventory `json:"providers"`
		}{app.options.Version, configuration.Language, binding, app.bridge.Status(), deployment, configuration.ServiceUpdatesPaused, app.profiles.Discover(), providers})
		return nil
	case path == "/api/vm/profiles" && method == http.MethodGet:
		writeJSON(writer, 200, app.profiles.Discover())
		return nil
	case path == "/api/vm/providers" && method == http.MethodGet:
		inventory, err := app.provisioning.Providers(ctx)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, inventory)
		return nil
	case path == "/api/fonts" && method == http.MethodGet:
		fonts, err := app.options.Fonts(ctx)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, fonts)
		return nil
	case path == "/api/notifications/pending" && method == http.MethodGet:
		app.mu.Lock()
		language := app.configuration.Language
		app.mu.Unlock()
		items := app.notifications.Pending()
		notifications := make([]struct {
			history.Notification
			Language string `json:"language"`
		}, 0, len(items))
		for _, item := range items {
			notifications = append(notifications, struct {
				history.Notification
				Language string `json:"language"`
			}{item, language})
		}
		writeJSON(writer, 200, struct {
			Notifications any `json:"notifications"`
		}{notifications})
		return nil
	case strings.HasPrefix(path, "/api/notifications/") && strings.HasSuffix(path, "/ack") && method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/notifications/"), "/ack")
		if id == "" || strings.Contains(id, "/") {
			return computer.ErrBinding
		}
		if err := app.notifications.Acknowledge(ctx, id); err != nil {
			return err
		}
		writeJSON(writer, 200, struct {
			OK bool `json:"ok"`
		}{true})
		return nil
	case path == "/api/provision" && method == http.MethodPost:
		raw, _, err := jsonRequest(request)
		if err != nil {
			return err
		}
		if err := app.backups.BeforeVMChange(ctx); err != nil {
			return err
		}
		state, err := app.provisioning.Start(ctx, raw)
		if err != nil {
			return err
		}
		writeJSON(writer, 200, state)
		return nil
	case path == "/api/connect" && method == http.MethodPost:
		return app.manualConnect(writer, request, true)
	case path == "/api/prepare" && method == http.MethodPost:
		if err := app.prepareConnection(ctx); err != nil {
			return err
		}
		writeJSON(writer, 200, struct {
			OK bool `json:"ok"`
		}{true})
		return nil
	case path == "/api/service-update" && method == http.MethodPost:
		_, object, err := jsonRequest(request)
		if err != nil {
			return err
		}
		action, err := requiredString(object, "action")
		if err != nil || !onlyFields(object, "action") {
			return computer.ErrBinding
		}
		if action == "install" {
			return app.manualConnect(writer, request, true)
		}
		if action != "pause" && action != "resume" {
			return computer.ErrBinding
		}
		app.configurationMu.Lock()
		defer app.configurationMu.Unlock()
		app.mu.Lock()
		configuration := app.configuration
		app.mu.Unlock()
		configuration.ServiceUpdatesPaused = action == "pause"
		if err := app.persistConfiguration(ctx, configuration); err != nil {
			return err
		}
		app.broadcastState()
		writeJSON(writer, 200, struct {
			OK bool `json:"ok"`
		}{true})
		return nil
	case strings.HasPrefix(path, "/api/desktop/") && method == http.MethodPost:
		return app.desktopRoute(writer, request)
	case path == "/api/vm/import" && method == http.MethodPost:
		return app.importProfile(writer, request)
	case path == "/api/settings" && method == http.MethodPatch:
		return app.patchSettings(writer, request)
	case path == "/api/voice-key" && (method == http.MethodPost || method == http.MethodDelete):
		if app.bridge.Snapshot().Call != nil {
			return apiError(409, "call_active", "End the call before changing its API key.")
		}
		if method == http.MethodPost {
			_, object, err := jsonRequest(request)
			if err != nil {
				return err
			}
			key, err := requiredString(object, "key")
			if err != nil {
				return err
			}
			if _, err := app.voiceKeys.Set(ctx, key); err != nil {
				return err
			}
		} else if _, err := app.voiceKeys.Clear(ctx); err != nil {
			return err
		}
		key, err := app.voiceKeys.Status()
		if err != nil {
			return err
		}
		app.broadcastState()
		writeJSON(writer, 200, struct {
			OK  bool               `json:"ok"`
			Key security.KeyStatus `json:"key"`
		}{true, key})
		return nil
	case strings.HasPrefix(path, "/api/backups"):
		return app.backupRoute(writer, request)
	case path == "/api/diagnostics":
		return app.diagnosticsRoute(writer, request)
	default:
		return app.proxy(writer, request)
	}
}

func (app *App) manualConnect(writer http.ResponseWriter, request *http.Request, deploy bool) error {
	if app.backups.Busy() {
		return backups.ErrBusy
	}

	if err := app.lease.AssertQuiescent(1); err != nil {
		return err
	}
	app.mu.Lock()
	if app.manual {
		app.mu.Unlock()
		return computer.ErrBridgeBusy
	}
	app.manual = true
	app.mu.Unlock()
	app.broadcastState()
	defer func() {
		app.mu.Lock()
		app.manual = false
		app.mu.Unlock()
		app.releasePrepared()
		app.broadcastState()
	}()
	if err := app.connect(request.Context(), true, deploy); err != nil {
		return err
	}
	writeJSON(writer, 200, struct {
		OK bool `json:"ok"`
	}{true})
	return nil
}

func (app *App) serveStatic(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.WriteHeader(405)
		return
	}
	name := request.URL.Path
	if name == "/" {
		name = "/index.html"
	}

	if strings.ContainsAny(name, "\\\x00") || strings.Contains(name, "..") || !strings.HasPrefix(name, "/") {
		http.NotFound(writer, request)
		return
	}
	root := filepath.Join(app.options.Root, "dist")
	file := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(name, "/")))
	raw, err := files.ReadRegular(file, 32*1024*1024)
	if err != nil {
		if filepath.Ext(name) == "" {
			file = filepath.Join(root, "index.html")
			raw, err = files.ReadRegular(file, 32*1024*1024)
		}
		if err != nil {
			http.NotFound(writer, request)
			return
		}
	}

	if kind := mime.TypeByExtension(filepath.Ext(file)); kind != "" {
		writer.Header().Set("Content-Type", kind)
	}
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(writer, request, filepath.Base(file), app.options.Now(), bytes.NewReader(raw))
}

func (app *App) proxy(writer http.ResponseWriter, request *http.Request) error {
	route := *request.URL
	query, err := url.ParseQuery(route.RawQuery)
	if err != nil {
		return computer.ErrBinding
	}
	query.Del("token")
	route.RawQuery = query.Encode()
	var body io.Reader = request.Body
	if request.Method == http.MethodPost && route.Path == "/api/call" {
		raw, object, err := jsonRequest(request)
		if err != nil {
			return err
		}
		var provider string
		_ = json.Unmarshal(object["provider"], &provider)
		if provider == "api" {
			key, err := app.voiceKeys.Get(request.Context())
			if err != nil || key == "" {
				return security.ErrAPIKey
			}
			object["apiKey"], _ = json.Marshal(key)
			raw, _ = json.Marshal(object)
		}
		body = bytes.NewReader(raw)
	}
	headers := http.Header{}
	if contentType := request.Header.Get("Content-Type"); contentType != "" {
		headers.Set("Content-Type", contentType)
	}
	response, err := app.bridge.Request(request.Context(), request.Method, route.RequestURI(), headers, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	for _, header := range []string{"Content-Type", "Content-Disposition", "Cache-Control", "X-Content-Type-Options"} {
		if value := response.Header.Get(header); value != "" {
			writer.Header().Set(header, value)
		}
	}
	writer.WriteHeader(response.StatusCode)
	if request.Method != http.MethodHead {
		if _, err := io.Copy(writer, response.Body); err != nil {
			panic(http.ErrAbortHandler)
		}
	}

	return nil
}

func importPassphrase(header string) (string, error) {
	if len(header) > base64.StdEncoding.EncodedLen(backups.PortablePassphraseMaxBytes) {
		return "", backups.ErrInvalid
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(header)
	if err != nil || base64.StdEncoding.EncodeToString(raw) != header || !utf8.Valid(raw) || len(raw) > backups.PortablePassphraseMaxBytes {
		return "", backups.ErrInvalid
	}

	return string(raw), nil
}
