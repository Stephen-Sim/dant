// Package app assembles the authoritative Linux Worker. Host Controllers use
// their own composition and never construct an Engine.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/settings"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
	"github.com/Stephen-Sim/dant/core/internal/updates"
	"github.com/Stephen-Sim/dant/core/internal/voice"
	"github.com/Stephen-Sim/dant/core/internal/voice/captions"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const workerCloseTimeout = 15 * time.Second

type WorkerOptions struct {
	Startup config.Startup
	Version string
	Source  string

	VerifyHost    func(context.Context) error
	StoreOptions  store.Options
	WorkerOptions workerRuntime.WorkerOptions
	VoiceHTTP     voice.HTTPDoer
	VoiceDial     voice.VoiceDial
	TelegramHTTP  telegram.HTTPDoer
}

type WorkerApp struct {
	ctx     context.Context
	cancel  context.CancelFunc
	options WorkerOptions
	handler http.Handler
	auth    *security.SessionAuth
	owner   *ownership.Lock

	store      *store.Store
	memory     *memory.Store
	worker     *workerRuntime.LocalWorker
	engine     *work.Engine
	supervisor *work.Supervisor

	attachments   *files.AttachmentStore
	deliverables  *files.DeliverableCollector
	skills        *skills.Library
	skillImporter *skills.Importer
	scheduleDB    *schedules.Database
	scheduler     *schedules.Scheduler
	telegram      *telegram.Gateway
	usage         *settings.TokenUsageStore

	computer     *computer.ComputerSession
	calls        *voice.Service
	apiVoice     *voice.API
	nativeVoice  *voice.Native
	transcriber  *voice.Transcriber
	callInputs   *voice.InputReferences
	callCaptions *captions.CaptionState

	vault           *security.Vault
	credentials     *security.CredentialRequests
	voiceKeys       *security.VoiceKeyStore
	diagnostics     *diagnostics.Logger
	updates         *updates.Service
	credentialToken string

	events        *eventHub
	lifecycle     sync.Mutex
	closed        bool
	operations    sync.WaitGroup
	maintenanceMu sync.Mutex
	maintenance   *workerMaintenance
	wake          chan struct{}
	wg            sync.WaitGroup
	startOnce     sync.Once
	closeOnce     sync.Once
}

// NewWorker validates the VM boundary before creating any authoritative files.
// It starts no connection, model session or external delivery until Start.
func NewWorker(ctx context.Context, options WorkerOptions) (app *WorkerApp, result error) {
	if options.Startup.Role != config.RoleWorker || options.Version == "" {
		return nil, config.ErrStartup
	}
	verify := options.VerifyHost
	if verify == nil {
		verify = func(ctx context.Context) error {
			return workerRuntime.VerifyVMHost(ctx, runtime.GOOS, os.Geteuid(), nil)
		}
	}
	if err := verify(ctx); err != nil {
		return nil, err
	}

	lifetime, cancel := context.WithCancel(ctx)
	app = &WorkerApp{
		ctx:     lifetime,
		cancel:  cancel,
		options: options,
		wake:    make(chan struct{}, 1),
		events:  newEventHub(),
	}
	defer func() {
		if result != nil {
			app.Close()
		}
	}()

	app.owner, result = ownership.Acquire(lifetime, options.Startup.DataDir)
	if result != nil {
		return app, result
	}
	app.diagnostics, result = diagnostics.New(lifetime, diagnostics.Options{
		DataDir: options.Startup.DataDir, Role: "vm-worker", Version: options.Version,
	})
	if result != nil {
		return app, result
	}
	app.store, result = store.OpenContext(lifetime, options.Startup.DataDir, options.StoreOptions)
	if result != nil {
		return app, result
	}
	app.memory, result = memory.OpenStore(lifetime, options.Startup.DataDir, memory.StoreOptions{})
	if result != nil {
		return app, result
	}
	if result = app.memory.MigrateLegacy(lifetime, app.store); result != nil {
		return app, result
	}
	if result = app.assembleStorage(); result != nil {
		return app, result
	}
	if result = app.assembleExecution(); result != nil {
		return app, result
	}
	if result = app.assembleIntegrations(); result != nil {
		return app, result
	}
	app.auth, result = security.NewSessionAuth("worker", options.Startup.Listen.Port, options.Startup.Network.Development.Port, security.SessionBuild{
		Version: options.Version, Source: options.Source,
	})
	if result != nil {
		return app, result
	}
	app.handler, result = app.routes()
	return app, result
}

func (app *WorkerApp) assembleStorage() error {
	var err error
	dataDir := app.options.Startup.DataDir
	app.attachments, err = files.OpenAttachmentStore(filepath.Join(dataDir, "attachments"))
	if err != nil {
		return err
	}
	app.deliverables = files.NewDeliverableCollector(app.attachments, app.notice)
	app.vault, err = security.NewVault(dataDir)
	if err != nil {
		return err
	}
	app.credentials = security.NewCredentialRequests(app.vault, app.change)
	app.voiceKeys, err = security.NewVoiceKeyStore(dataDir, "linux", app.options.Startup.Environment["OPENAI_API_KEY"], nil)
	if err != nil {
		return err
	}
	app.usage, err = settings.NewTokenUsageStore(app.store, settings.UsageOptions{Changed: app.change})
	if err != nil {
		return err
	}
	workspace := filepath.Join(app.options.Startup.WorkspaceRoot, app.store.ConversationID())
	app.skills, err = skills.New(workspace, skills.Options{
		ContainsSecret: func(ctx context.Context, text string) bool {
			contains, err := app.vault.ContainsSecret(ctx, text)
			return err != nil || contains
		},
	})
	if err != nil {
		return err
	}
	app.skillImporter = skills.NewImporter(app.ctx, app.skills, nil, nil)
	var token [32]byte
	if _, err = rand.Read(token[:]); err != nil {
		return err
	}
	app.credentialToken = hex.EncodeToString(token[:])
	app.callCaptions = captions.NewCaptionState(app.redact)
	return nil
}

func (app *WorkerApp) assembleExecution() error {
	options := app.options.WorkerOptions
	options.Home = app.options.Startup.Home
	options.WorkspaceRoot = app.options.Startup.WorkspaceRoot
	options.RuntimeID = app.options.Startup.RuntimeID
	options.GuestOrigin = app.options.Startup.Network.Guest.HTTPOrigin
	options.Environment = config.EnvironmentList(app.options.Startup.Environment)
	options.CredentialBridgeToken = app.credentialToken
	changed := options.Changed
	options.Changed = func() {
		app.change()
		if changed != nil {
			changed()
		}
	}
	options.SkillContext = func() string {
		context, err := app.skills.Context(app.ctx)
		if err != nil {
			return ""
		}
		return context
	}
	var err error
	app.worker, err = workerRuntime.NewLocalWorker(app.ctx, app.store, options)
	if err != nil {
		return err
	}
	app.apiVoice, err = voice.NewAPI(app.ctx, voice.APIOptions{
		GetKey: app.voiceKeys.Get,
		RunTask: func(ctx context.Context, text string, owner work.ToolContext) (json.RawMessage, error) {
			return app.engine.RunVoiceTask(ctx, text, owner)
		},
		Tool: func(ctx context.Context, name string, args contracts.RawObject, owner work.ToolContext) (json.RawMessage, error) {
			return app.engine.Tool(ctx, name, args, owner)
		},
		Context: func(ctx context.Context, reactionsOnly bool) (string, error) {
			return app.engine.APIConversationContext(ctx, reactionsOnly)
		},
		OnConversationItem: func(ctx context.Context, item voice.ConversationItem) error {
			return app.engine.RecordSpeech(ctx, work.SpeechInput{
				CallID: item.CallID, ItemID: item.ItemID, Role: item.Role, Text: item.Text,
			})
		},
		Redact: func(text string, additional []string) string {
			redacted, err := app.vault.Redact(app.ctx, text, true, additional)
			if err != nil {
				return ""
			}
			return redacted
		},
		Subtitle: app.caption, Changed: app.change, Notice: app.notice,
		Usage: func(params contracts.RawObject) {
			if _, err := app.usage.ObserveAPIVoice(app.ctx, encode(params)); err != nil {
				app.notice("Token usage could not be saved.")
			}
		},
		HTTP: app.options.VoiceHTTP, Dial: app.options.VoiceDial,
	})
	if err != nil {
		return err
	}
	app.calls = voice.NewService(voice.ServiceOptions{
		API:     app.apiVoice,
		History: app.store,
		ContinueVoiceTasks: func(ctx context.Context, callID string) error {
			return app.engine.ContinueVoiceTasks(callID)
		},
		CancelOwner: func(ctx context.Context, callID string) error {
			app.credentials.CancelOwner(callID)
			return nil
		},
		Settings: func() contracts.Settings {
			return app.store.Snapshot().Settings
		},
		Memory: func(ctx context.Context) (string, error) {
			return app.memory.Context(ctx, false)
		},
		RememberCallInput: func(ctx context.Context, message *contracts.ChatMessage, callID string) error {
			return app.callInputs.Remember(ctx, message, callID)
		},
	})
	app.transcriber, err = voice.NewTranscriber(voice.TranscriberOptions{
		Attachments: app.attachments, Home: app.options.Startup.Home,
	})
	if err != nil {
		return err
	}
	app.engine, err = work.New(app.ctx, app.store, app.worker, work.Options{
		ToolRouter: app,
		Memory: work.ReferenceMemoryFunc(func(ctx context.Context, query, conversationID, workID string) (string, error) {
			var workIdentity *string
			if workID != "" {
				workIdentity = &workID
			}
			return app.memory.AgentContext(ctx, query, memory.Scope{ConversationID: conversationID, WorkID: workIdentity}, nil, app.redact)
		}),
		DurableMemory: app.memory, DesktopPath: app.worker.DesktopPath(),
		Usage: app.usage, Deliverables: app.deliverables, Calls: app.calls,
		Redact:     func(ctx context.Context, text string) string { return app.redactContext(ctx, text) },
		OwnerEnded: app.credentials.CancelOwner,
		Transcribe: func(ctx context.Context, file contracts.Attachment) (string, error) {
			result, err := app.transcriber.Transcribe(ctx, file.ID)
			return result.Text, err
		},
		RecognizedCallInput: func(ctx context.Context, callID string, message *contracts.ChatMessage) error {
			result := app.calls.SyncContext(ctx, callID, "message", message)
			if result.Status != contracts.LiveContextStatusSubmitted && result.Status != contracts.LiveContextStatusSuperseded {
				return voice.ErrVoiceContext
			}
			return nil
		},
	})
	if err != nil {
		return err
	}
	app.supervisor, err = work.NewSupervisor(app.ctx, app.engine, app.store, work.SupervisorOptions{Notice: app.notice})
	if err != nil {
		return err
	}
	app.callInputs, err = voice.NewInputReferences(voice.ReferenceOptions{
		Store: app.store, Inject: app.engine.InjectReference,
		Current: app.callInputCurrent, Redact: app.redact,
	})
	if err != nil {
		return err
	}
	app.nativeVoice, err = voice.NewNative(app.ctx, voice.NativeOptions{
		Worker: app.worker, Engine: app.engine, Store: app.store,
		Redact: app.redact, Subtitle: app.caption, Changed: app.change, Notice: app.notice,
		RememberCallInput: app.callInputs.Remember,
		MemoryReference: func(ctx context.Context, message *contracts.ChatMessage) (string, error) {
			return app.engine.MemoryReference(ctx, message, message.WorkID, message.Text)
		},
	})
	if err != nil {
		return err
	}
	if err = app.calls.AttachNative(app.nativeVoice); err != nil {
		return err
	}
	if err = app.calls.AttachReservations(app.engine); err != nil {
		return err
	}
	app.computer, err = computer.NewComputerSession(app.ctx, app.engine, app.worker, computer.SessionOptions{Changed: app.change})
	return err
}

func (app *WorkerApp) assembleIntegrations() error {
	state := app.store.Snapshot()
	var err error
	app.scheduleDB, err = schedules.OpenDatabase(app.ctx, app.options.Startup.DataDir, state.Schedules, state.DeletedScheduleRequestIDs)
	if err != nil {
		return err
	}
	app.scheduler, err = schedules.New(app.ctx, app.scheduleDB, app.store, schedules.Options{
		Available: app.canSchedule,
		ActiveIDs: func() []string {
			active := app.engine.Snapshot().Active
			if active == nil {
				return nil
			}
			return active.MessageIDs
		},
		QueuedIDs: func() []string { return app.engine.Snapshot().Queue },
		Enqueue:   app.engine.Enqueue, Changed: app.change,
	})
	if err != nil {
		return err
	}
	app.telegram, err = telegram.Open(app.ctx, app.options.Startup.DataDir, telegram.Options{
		Store: app.store, Attachments: app.attachments,
		Admit: app.admitTelegram, WorkSnapshot: app.telegramWork,
		Pause: app.engine.Pause,
		Resume: func(ctx context.Context, ids []string) error {
			_, err := app.engine.ResumePaused(ctx, ids, work.ResumeOptions{})
			return err
		},
		StopOwned: app.stopTelegramWork,
		Redact:    app.redact, Changed: app.change,
		HTTP: app.options.TelegramHTTP, AutoPoll: true,
	})
	return err
}

func encode(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return raw
}

func (app *WorkerApp) Handler() http.Handler { return app.handler }

func (app *WorkerApp) change() {
	select {
	case app.wake <- struct{}{}:
	default:
	}
}

func (app *WorkerApp) notice(message string) {
	app.events.publish("notice", struct {
		Message string `json:"message"`
	}{app.redact(message)})
}

func (app *WorkerApp) redactContext(ctx context.Context, text string) string {
	if app.vault == nil {
		return ""
	}
	redacted, err := app.vault.Redact(ctx, text, true, nil)
	if err != nil {
		return ""
	}
	return redacted
}

func (app *WorkerApp) redact(text string) string { return app.redactContext(app.ctx, text) }

func (app *WorkerApp) caption(value voice.Caption) {
	if app.calls == nil || app.engine == nil {
		return
	}
	app.callCaptions.Sync(app.calls.Snapshot(), app.store.ConversationID(), app.online())
	if app.callCaptions.Observe(value) {
		app.events.publish("realtime", struct {
			Method string        `json:"method"`
			Params voice.Caption `json:"params"`
		}{captions.CaptionEventMethod, value})
	}
}

func (app *WorkerApp) online() bool {
	return app.ctx.Err() == nil && app.worker != nil && app.worker.Snapshot().Status == contracts.ConnectionStatusOnline
}

func (app *WorkerApp) canSchedule() bool {
	if !app.online() {
		return false
	}
	state := app.engine.Snapshot()
	return !state.Takeover && !state.Acquiring && !state.Executor.Paused && state.Call == nil && !app.engine.MaintenanceActive()
}

func (app *WorkerApp) callInputCurrent(conversationID, callID, messageID string) bool {
	if !app.online() || app.store.ConversationID() != conversationID {
		return false
	}
	state := app.engine.Snapshot()
	if state.Takeover || state.Acquiring || state.Call == nil || state.Call.ID != callID {
		return false
	}
	_, err := app.store.Message(messageID)
	return err == nil
}

func (app *WorkerApp) Start() {
	app.lifecycle.Lock()
	defer app.lifecycle.Unlock()
	if app.closed {
		return
	}
	app.startOnce.Do(func() {
		app.wg.Add(1)
		go app.broadcast()
		app.scheduler.Start(app.ctx)
		app.supervisor.Start()
		app.telegram.Start()
		app.wg.Add(1)
		go func() {
			defer app.wg.Done()
			if app.engine.UnconfirmedStop() {
				app.notice("The previous executor stop could not be confirmed. Verify that it stopped before reconnecting.")
				return
			}
			err := app.connectionOperation(app.ctx, false, func(ctx context.Context) error {
				_, err := app.worker.Connect(ctx)
				return err
			})
			if err != nil && app.ctx.Err() == nil {
				app.notice("The work computer service could not connect.")
			}
			app.change()
		}()
	})
}

func (app *WorkerApp) Close() {
	app.closeOnce.Do(func() {
		app.lifecycle.Lock()
		app.closed = true
		app.events.close()
		app.cancel()
		app.lifecycle.Unlock()
		closing, stop := context.WithTimeout(context.WithoutCancel(app.ctx), workerCloseTimeout)
		defer stop()
		if app.callCaptions != nil {
			app.callCaptions.End()
		}
		if app.credentials != nil {
			app.credentials.Close()
		}
		if app.scheduler != nil {
			_ = app.scheduler.Close()
		}
		if app.supervisor != nil {
			_ = app.supervisor.Close(closing)
		}
		if app.updates != nil {
			app.updates.Close()
		}
		if app.computer != nil {
			app.computer.Close()
		}
		if app.skillImporter != nil {
			app.skillImporter.Close()
		}
		if app.telegram != nil {
			_ = app.telegram.Close(closing)
		}
		if app.apiVoice != nil {
			_ = app.apiVoice.Close(closing)
		}
		if app.nativeVoice != nil {
			_ = app.nativeVoice.Close(closing)
		}
		if app.transcriber != nil {
			_ = app.transcriber.Close(closing)
		}
		if app.engine != nil {
			_ = app.engine.Close()
		}
		stopped := true
		if app.worker != nil {
			stopped = app.worker.CloseContext(closing) == nil
		}
		app.wg.Wait()
		app.operations.Wait()

		// Keep admission fenced if process termination could not be proved. A
		// cancelled shutdown deadline must not also cancel this durable write.
		if !stopped && app.engine != nil {
			fencing, cancel := context.WithTimeout(context.WithoutCancel(app.ctx), workerCloseTimeout)
			err := app.engine.FenceUnconfirmedStop(fencing)
			cancel()
			if app.diagnostics != nil {
				code := "EXECUTOR_STOP_UNCONFIRMED"
				if err != nil {
					code = "EXECUTOR_STOP_FENCE_FAILED"
				}
				app.diagnostics.Log("worker.shutdown", diagnostics.Fields{Code: code})
			}
		}
		if app.scheduleDB != nil {
			_ = app.scheduleDB.Close()
		}
		if app.memory != nil {
			_ = app.memory.Close()
		}
		if app.store != nil {
			app.store.Close()
		}
		if app.diagnostics != nil {
			app.diagnostics.Close()
		}
		if app.owner != nil && stopped {
			_ = app.owner.Close()
		}
	})
}

var errUnavailable = errors.New("worker_operation_unavailable")
