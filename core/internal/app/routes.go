package app

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
	"github.com/Stephen-Sim/dant/core/internal/updates"
	"github.com/Stephen-Sim/dant/core/internal/voice"
)

const staticFileBytes = 16 * 1024 * 1024

var bridgeTools = []string{
	"task_plan", "task_list", "task_cancel", "chat_delivery_policy",
	"credential_find", "credential_get", "credential_request", "credential_store",
	"skill_list", "skill_get", "skill_save",
	"schedule_list", "schedule_save", "schedule_delete",
}

var nativeVoiceName = regexp.MustCompile(`^[a-z]+$`)

const modelNameUnits = 120

func (app *WorkerApp) routes() (http.Handler, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session", app.auth.ServeSession)
	httpapi.Register(mux, "GET /api/state", func(writer http.ResponseWriter, request *http.Request) error {
		writer.Header().Set("Cache-Control", "no-store")
		state, err := app.Snapshot(request.Context())
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, state)
	})
	mux.HandleFunc("GET /api/events", app.serveSSE)
	mux.HandleFunc("GET /events", app.serveWebSocket)
	app.registerOperationalRoutes(mux)
	app.registerBackupRoutes(mux)
	app.registerSettingsRoutes(mux)
	app.registerScheduleRoutes(mux)
	registerConversationRoutes(mux, app)
	registerWorkRoutes(mux, app)
	recovery, err := files.NewRecovery(files.RecoveryOptions{
		Store: app.store, Collector: app.deliverables,
		OutputDirectory: func() string {
			return filepath.Join(app.options.Startup.WorkspaceRoot, app.store.ConversationID(), "output")
		},
		ConversationTransaction: app.engine.ConversationTransaction, OnChange: app.change,
	})
	if err != nil {
		return nil, err
	}
	httpapi.Register(mux, "POST /api/messages/{id}/output-link/resolve", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		result, err := recovery.Resolve(request.Context(), request.PathValue("id"), body)
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	})
	registerFileRoutes(mux, app.attachments, app.change)
	security.RegisterCredentialRoutes(mux, app.credentials)
	security.RegisterCredentialRevealRoute(mux, app.credentials, app.store.ConversationID)
	skills.RegisterRoutes(mux, skills.RouteOptions{
		Library: app.skills, Importer: app.skillImporter, Attachments: app.attachments,
		Online: app.online,
		Reload: func(ctx context.Context) { app.engine.InvalidateContext() },
	})
	memory.RegisterRoutes(mux, memory.RouteOptions{
		Store: app.memory, ConversationID: app.store.ConversationID,
		Redact: app.redactContext, ConversationTransaction: app.engine.ConversationTransaction,
		Changed: app.memoryChanged, SaveNote: app.saveNote,
	})
	voice.RegisterRoutes(mux, voice.RouteOptions{
		Service: app.calls, Keys: app.voiceKeys, Ready: app.online, Changed: app.change,
	})
	telegram.RegisterRoutes(mux, app.telegram)
	httpapi.Register(mux, "POST /api/internal/credentials", app.credentialBridge)
	mux.HandleFunc("/api/", func(writer http.ResponseWriter, _ *http.Request) {
		httpapi.WriteError(writer, httpapi.Failure(404, "route_not_found", "The requested operation is unavailable."))
	})
	mux.HandleFunc("/", app.serveStatic)
	return app.guardRequests(app.auth.Middleware(mux, app.bridgeAuthorized)), nil
}

func (app *WorkerApp) guardRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		app.lifecycle.Lock()
		if app.closed {
			app.lifecycle.Unlock()
			http.Error(writer, "Service closing", http.StatusServiceUnavailable)
			return
		}
		app.operations.Add(1)
		app.lifecycle.Unlock()
		defer app.operations.Done()
		ctx, cancel := context.WithCancel(request.Context())
		defer cancel()
		control := http.NewResponseController(writer)
		stop := context.AfterFunc(app.ctx, func() {
			cancel()
			_ = control.SetReadDeadline(time.Now())
			_ = control.SetWriteDeadline(time.Now())
			if request.Body != nil {
				_ = request.Body.Close()
			}
		})
		defer stop()
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (app *WorkerApp) bridgeAuthorized(request *http.Request) bool {
	values := request.Header.Values("X-Dant-Credential-Token")
	return request.Method == http.MethodPost && len(values) == 1 &&
		subtle.ConstantTimeCompare([]byte(values[0]), []byte(app.credentialToken)) == 1
}

func (app *WorkerApp) credentialBridge(writer http.ResponseWriter, request *http.Request) error {
	if !app.bridgeAuthorized(request) {
		return httpapi.Failure(403, "bridge_forbidden", "Credential bridge authorization failed.")
	}
	owner, valid := app.engine.ToolScope()
	if !valid {
		return httpapi.Failure(409, "owner_required", "A current acknowledged VM task is required.")
	}
	body, err := httpapi.ReadObject(writer, request, 0)
	if err != nil {
		return err
	}
	name, err := httpapi.String(body, "tool", true)
	if err != nil || !slices.Contains(bridgeTools, name) {
		return httpapi.Failure(400, "invalid_bridge_operation", "Invalid credential operation.")
	}
	args, err := contracts.DecodeObject(body["arguments"], len(body["arguments"]))
	if err != nil {
		return httpapi.Failure(400, "invalid_bridge_operation", "Invalid credential operation.")
	}
	result, err := app.engine.Tool(request.Context(), name, args, owner)
	if err != nil {
		return err
	}
	if !owner.IsCurrent() {
		return httpapi.Failure(409, "owner_changed", "The operation is no longer active.")
	}
	return httpapi.JSON(writer, result)
}

func (app *WorkerApp) registerOperationalRoutes(mux *http.ServeMux) {
	service := updates.New(updates.Options{Version: app.options.Version, HTTP: app.options.UpdateHTTP})
	app.updates = service
	for _, route := range []string{"/api/version", "/api/updates"} {
		mux.HandleFunc(route, func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Cache-Control", "no-store")
			if request.Method != http.MethodGet {
				writer.Header().Set("Allow", "GET")
				httpapi.WriteError(writer, httpapi.Failure(405, "read_only", "Update information is read-only."))
				return
			}
			if route == "/api/version" {
				_ = httpapi.JSON(writer, updates.Info{
					Version: app.options.Version, RepositoryURL: updates.RepositoryURL, ReleasesURL: updates.ReleasesURL,
				})
				return
			}
			channel := "stable"
			if values, exists := request.URL.Query()["channel"]; exists {
				if len(values) != 1 {
					httpapi.WriteError(writer, httpapi.Failure(400, "UPDATE_INVALID_CHANNEL", "Choose Stable or Beta for updates."))
					return
				}
				channel = values[0]
			}
			result, err := service.Check(request.Context(), channel)
			if err != nil {
				var failure *updates.Error
				if errors.As(err, &failure) {
					err = httpapi.Failure(failure.Status, failure.Code, failure.Message)
				}
				httpapi.WriteError(writer, err)
				return
			}
			_ = httpapi.JSON(writer, result)
		})
	}
	mux.HandleFunc("/api/diagnostics", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		if request.Method != http.MethodGet {
			httpapi.WriteError(writer, httpapi.Failure(405, "read_only", "Diagnostics are read-only."))
			return
		}
		recent, err := app.diagnostics.Recent(request.Context(), 50)
		if err != nil {
			httpapi.WriteError(writer, err)
			return
		}
		_ = httpapi.JSON(writer, struct {
			Status diagnostics.Status   `json:"status"`
			Recent []diagnostics.Record `json:"recent"`
		}{app.diagnostics.Status(), recent})
	})
	httpapi.Register(mux, "GET /api/backups/info", func(writer http.ResponseWriter, _ *http.Request) error {
		info, err := backups.LoadedWorkerRestoreInfo(app.options.Startup.DataDir, app.options.Startup.WorkspaceRoot)
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, info)
	})
	httpapi.Register(mux, "POST /api/connect", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 4096)
		if err != nil {
			return err
		}
		idle, err := httpapi.Boolean(body, "idleRecovery", false)
		if err != nil {
			return err
		}
		state := app.engine.Snapshot()
		busy := state.Active != nil || state.Call != nil || state.Finishing ||
			len(state.PendingFollowups) > 0 || app.calls.PendingWork()
		if idle {
			busy = busy || len(state.Queue) > 0 || state.Takeover || state.Acquiring || app.computer.Pending()
		}
		if busy {
			return httpapi.Failure(409, "worker_busy", "Stop active work and return computer control before reconnecting.")
		}
		err = app.connectionOperation(request.Context(), idle, func(ctx context.Context) error {
			if !idle || !app.online() {
				_, err := app.worker.Connect(ctx)
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
		app.engine.InvalidateContext()
		app.change()
		return httpapi.JSON(writer, struct {
			OK bool `json:"ok"`
		}{true})
	})
	httpapi.Register(mux, "POST /api/login", func(writer http.ResponseWriter, request *http.Request) error {
		var result contracts.RawObject
		err := app.connectionOperation(request.Context(), false, func(ctx context.Context) error {
			var err error
			result, err = app.worker.Request(ctx, "account/login/start", contracts.RawObject{"type": encode("chatgptDeviceCode")})
			return err
		})
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/logout", func(writer http.ResponseWriter, request *http.Request) error {
		state := app.engine.Snapshot()
		if state.Active != nil || state.Call != nil || state.Finishing || len(state.PendingFollowups) > 0 || app.calls.PendingWork() {
			return httpapi.Failure(409, "worker_busy", "Stop active work first.")
		}
		err := app.connectionOperation(request.Context(), true, func(ctx context.Context) error {
			_, err := app.worker.Request(ctx, "account/logout", contracts.RawObject{})
			return err
		})
		if err != nil {
			return err
		}
		app.change()
		return httpapi.JSON(writer, struct {
			OK bool `json:"ok"`
		}{true})
	})
	httpapi.Register(mux, "POST /api/provision", func(_ http.ResponseWriter, _ *http.Request) error {
		return httpapi.Failure(409, "controller_required", "Work computer creation belongs to the desktop Controller.")
	})
}

func (app *WorkerApp) registerSettingsRoutes(mux *http.ServeMux) {
	httpapi.Register(mux, "PATCH /api/settings", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		if _, exists := body["vm"]; exists {
			return httpapi.Failure(400, "controller_required", "VM connection settings belong to the desktop Controller.")
		}
		conversation := app.store.ConversationID()
		requiresIdle := false
		for _, key := range []string{"model", "voice", "nativeVoice", "apiVoice"} {
			if _, exists := body[key]; exists {
				requiresIdle = true
			}
		}
		err = app.engine.PreferenceTransaction(request.Context(), conversation, requiresIdle, func(ctx context.Context) error {
			return app.store.Mutate(ctx, func(state *contracts.State) error {
				for _, key := range []string{"notifications", "showWorkSummary", "showCallCaptions"} {
					if _, exists := body[key]; !exists {
						continue
					}
					value, err := httpapi.Boolean(body, key, false)
					if err != nil {
						return err
					}
					switch key {
					case "notifications":
						state.Settings.Notifications = value
					case "showWorkSummary":
						state.Settings.ShowWorkSummary = value
					case "showCallCaptions":
						state.Settings.ShowCallCaptions = value
					}
				}
				if _, exists := body["language"]; exists {
					language, err := httpapi.String(body, "language", true)
					if err != nil || !i18n.IsLanguage(language) {
						return httpapi.Failure(400, "invalid_language", "Invalid language.")
					}
					state.Settings.Language = language
				}
				if _, exists := body["timeZone"]; exists {
					zone, err := httpapi.String(body, "timeZone", true)
					canonical, valid := i18n.CanonicalTimeZone(zone)
					if err != nil || !valid {
						return httpapi.Failure(400, "invalid_time_zone", "Invalid time zone.")
					}
					state.Settings.TimeZone = canonical
				}
				for _, key := range []string{"voice", "nativeVoice", "apiVoice", "model"} {
					if _, exists := body[key]; !exists {
						continue
					}
					value, err := httpapi.String(body, key, true)
					if err != nil {
						return err
					}
					switch key {
					case "voice", "nativeVoice":
						if !nativeVoiceName.MatchString(value) {
							return httpapi.Failure(400, "invalid_voice", "Invalid voice.")
						}
						if key == "voice" {
							if _, explicit := body["nativeVoice"]; explicit {
								continue
							}
						}
						state.Settings.Voice = value
						state.Settings.NativeVoice = value
					case "apiVoice":
						if !slices.Contains(voice.APIVoices(), value) {
							return httpapi.Failure(400, "invalid_voice", "Invalid voice.")
						}
						state.Settings.APIVoice = value
					case "model":
						if contracts.UTF16Length(value) >= modelNameUnits {
							return httpapi.Failure(400, "invalid_model", "Invalid model.")
						}
						state.Settings.Model = value
					}
				}
				return nil
			})
		})
		if err != nil {
			return conversationRouteError(err)
		}
		app.engine.InvalidateContext()
		return httpapi.JSON(writer, struct {
			OK bool `json:"ok"`
		}{true})
	})
}

func scheduleRouteError(err error) error {
	switch {
	case errors.Is(err, schedules.ErrInvalid):
		return httpapi.Failure(400, "invalid_schedule", "Invalid scheduled task.")
	case errors.Is(err, schedules.ErrNotFound):
		return httpapi.Failure(404, "schedule_not_found", "Scheduled task not found.")
	case errors.Is(err, schedules.ErrConflict):
		return httpapi.Failure(409, "schedule_changed", "The scheduled task changed. Refresh its current status.")
	case errors.Is(err, schedules.ErrUnavailable):
		return httpapi.Failure(503, "schedule_unavailable", "Scheduled tasks are temporarily unavailable.")
	default:
		return err
	}
}

func (app *WorkerApp) registerScheduleRoutes(mux *http.ServeMux) {
	httpapi.Register(mux, "GET /api/schedules", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := app.scheduler.List(request.Context())
		if err != nil {
			return scheduleRouteError(err)
		}
		return httpapi.JSON(writer, result)
	})
	for _, pattern := range []string{"POST /api/schedules", "PATCH /api/schedules/{id}"} {
		httpapi.Register(mux, pattern, func(writer http.ResponseWriter, request *http.Request) error {
			body, err := httpapi.ReadObject(writer, request, 0)
			if err != nil {
				return err
			}
			if id := request.PathValue("id"); id != "" {
				if raw, exists := body["id"]; exists && !bytes.Equal(raw, encode(id)) {
					return httpapi.Failure(400, "schedule_id_changed", "The scheduled task id changed.")
				}
				body["id"] = encode(id)
			}
			result, err := app.scheduler.Save(request.Context(), encode(body), true)
			if err != nil {
				return scheduleRouteError(err)
			}
			return httpapi.JSON(writer, result)
		})
	}
	httpapi.Register(mux, "DELETE /api/schedules/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := app.scheduler.Remove(request.Context(), request.PathValue("id"))
		if err != nil {
			return scheduleRouteError(err)
		}
		return httpapi.JSON(writer, result)
	})
}

func (app *WorkerApp) serveStatic(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.NotFound(writer, request)
		return
	}
	root, err := files.OpenManagedRoot(filepath.Join(app.options.Startup.Root, "dist"), false)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	defer root.Close()
	name := strings.TrimPrefix(request.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if path.Clean(name) != name || strings.ContainsRune(name, '\\') {
		http.NotFound(writer, request)
		return
	}
	data, err := root.ReadFile(request.Context(), name, staticFileBytes)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Cache-Control", "no-cache")
	if kind := mime.TypeByExtension(path.Ext(name)); kind != "" {
		writer.Header().Set("Content-Type", kind)
	}
	http.ServeContent(writer, request, name, time.Time{}, bytes.NewReader(data))
}
