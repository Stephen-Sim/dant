package controller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/settings"
	"github.com/Stephen-Sim/dant/core/internal/updates"
	"github.com/Stephen-Sim/dant/core/internal/voice/captions"
)

const cacheWriteTimeout = 5 * time.Second
const controllerConnectTimeout = 3 * time.Minute
const controllerDeploymentTimeout = computer.DeploymentTimeout + controllerConnectTimeout
const controllerAutomaticInterval = 5 * time.Second

type Bridge interface {
	DesktopBridge
	Generation() uint64
	Prepare(context.Context) error
	Request(context.Context, string, string, http.Header, io.Reader) (*http.Response, error)
	Close()
}

type Options struct {
	Root, DataDir, Version, BuildSource, TimeZone string
	Network                                       config.Network
	Environment                                   map[string]string
	Host                                          platform.Host
	Protector                                     security.Protector
	PrepareOnly                                   bool
	Executable                                    string
	Now                                           func() time.Time
	BridgeFactory                                 func(computer.BridgeOptions) (Bridge, error)
	Prepare                                       func(context.Context, computer.Binding) error
	BackupTransport                               backups.BackupTransport
	BackupTransform                               func(context.Context, backups.TransformRequest) error
	Profiles                                      *computer.Profiles
	Providers                                     *computer.Providers
	ReleaseHTTP                                   updates.HTTPDoer
	Fonts                                         func(context.Context) (settings.FontInventory, error)
	Diagnostics                                   *diagnostics.Logger
}

type App struct {
	mu                sync.Mutex
	configurationMu   sync.Mutex
	connectMu         sync.Mutex
	preferenceMu      sync.Mutex
	options           Options
	ctx               context.Context
	cancel            context.CancelFunc
	auth              *security.SessionAuth
	bridge            Bridge
	deployer          *computer.Deployer
	provisioning      *computer.Provisioning
	profiles          *computer.Profiles
	voiceKeys         *security.VoiceKeyStore
	notifications     *history.NotificationHub
	diagnostics       *diagnostics.Logger
	desktop           *DesktopLifecycle
	lifecycle         OwnedVMLifecycle
	updates           *updates.Service
	lease             *updates.InstallLease
	backups           *backups.Manager
	events            *eventHub
	callCaptions      *captions.CaptionState
	configuration     Configuration
	cached            contracts.WorkerSnapshot
	lastSaved         int64
	profileError      *string
	manual            bool
	connectionPending bool
	started           bool
	closed            bool
	cacheWake         chan struct{}
	closeOnce         sync.Once
	wg                sync.WaitGroup
	handler           http.Handler
}

// New only assembles host services. Start explicitly enables the owned
// connection/maintenance loop after the HTTP server is ready. No Engine or
// authoritative conversation Store is constructed on the Controller.
func New(ctx context.Context, options Options) (app *App, result error) {
	if ctx == nil || !filepath.IsAbs(options.Root) || !filepath.IsAbs(options.DataDir) || options.Version == "" {
		return nil, computer.ErrBinding
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if _, err := files.OrdinaryDirectory(options.Root, false); err != nil {
		return nil, err
	}

	if _, err := files.OrdinaryDirectory(options.DataDir, true); err != nil {
		return nil, err
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.Executable == "" {
		options.Executable, _ = os.Executable()
	}

	if options.Network.API.Port == 0 {
		network, err := config.ReadNetwork(options.Environment)
		if err != nil {
			return nil, err
		}
		options.Network = network
	}

	if options.Host.ID == "" {
		host, err := platform.New(runtimePlatform(), options.Environment, options.Protector)
		if err != nil {
			return nil, err
		}
		options.Host = host
	}

	if options.Protector == nil && options.Host.Protection != nil {
		options.Protector = options.Host.Protection
	}
	owner, cancel := context.WithCancel(ctx)
	app = &App{
		options:       options,
		ctx:           owner,
		cancel:        cancel,
		events:        newEventHub(),
		callCaptions:  captions.NewCaptionState(nil),
		configuration: readConfiguration(options.DataDir),
		cached:        readCached(options.DataDir),
		cacheWake:     make(chan struct{}, 1),
	}
	initializing := app
	defer func() {
		if result != nil {
			initializing.Close()
		}
	}()
	var err error
	app.diagnostics = options.Diagnostics
	if app.diagnostics == nil {
		app.diagnostics, err = diagnostics.New(owner, diagnostics.Options{DataDir: options.DataDir, Role: "controller", Version: options.Version, Now: options.Now})
		if err != nil {
			return nil, err
		}
	}
	if options.TimeZone == "" {
		app.diagnostics.Log("configuration.timezone", diagnostics.Fields{Code: "HOST_TIMEZONE_UNAVAILABLE"})
	}
	app.auth, err = security.NewSessionAuth("controller", options.Network.API.Port, options.Network.Development.Port, security.SessionBuild{
		Version: options.Version, Source: options.BuildSource,
	})
	if err != nil {
		return nil, err
	}
	app.voiceKeys, err = security.NewVoiceKeyStore(options.DataDir, options.Host.OS, options.Environment["OPENAI_API_KEY"], options.Protector)
	if err != nil {
		return nil, err
	}
	app.notifications, err = history.OpenNotificationHub(options.DataDir, history.NotificationOptions{Now: options.Now})
	if err != nil {
		return nil, err
	}

	if err := app.notifications.Configure(owner, app.configuration.Notifications); err != nil {
		return nil, err
	}
	app.updates = updates.New(updates.Options{Version: options.Version, HTTP: options.ReleaseHTTP})
	app.profiles = options.Profiles
	if app.profiles == nil {
		home, _ := os.UserHomeDir()
		profileOwner, err := computer.CurrentProfileOwner()
		if err != nil {
			return nil, err
		}
		candidates := []string{}
		if directory := options.Environment["DANT_VM_PROFILE_DIR"]; directory != "" {
			candidates = append(candidates, directory)
		}
		if raw := options.Environment["DANT_VM_PROFILE_DIRS"]; len(raw) <= controllerConfigLimit {
			var values []string
			if json.Unmarshal([]byte(raw), &values) == nil {
				candidates = append(candidates, values...)
			}
		}
		app.profiles, err = computer.NewProfiles(computer.ProfileOptions{
			DataDir:        options.DataDir,
			ProjectRoot:    options.Root,
			RegistryFile:   computer.DefaultProfileRegistry(home, options.Environment),
			Owner:          profileOwner,
			CandidateDirs:  candidates,
			IncludeProject: true,
			Now:            options.Now,
		})
		if err != nil {
			return nil, err
		}
	}

	if _, err := app.profiles.AutoImport(owner); err != nil {
		message := "The VM connection needs to be selected or repaired."
		app.profileError = &message
	}
	providers := options.Providers
	if providers == nil {
		providers = computer.NewProviders(options.Host, computer.ProviderDetection{})
	}
	app.provisioning, err = computer.NewProvisioning(computer.ProvisioningOptions{
		Context:     owner,
		ProjectRoot: options.Root,
		DataDir:     options.DataDir,
		Host:        options.Host,
		Providers:   providers,
		Changed:     app.broadcastState,
	})
	if err != nil {
		return nil, err
	}
	prepare := options.Prepare
	if prepare == nil {
		app.deployer, err = computer.NewDeployer(computer.DeploymentOptions{
			Context:     owner,
			ProjectRoot: options.Root,
			DataDir:     options.DataDir,
			Version:     options.Version,
			BuildSource: options.BuildSource,
			Network:     options.Network,
			Changed:     app.broadcastState,
		})
		if err != nil {
			return nil, err
		}
		prepare = app.deployer.Prepare
	}
	factory := options.BridgeFactory
	if factory == nil {
		factory = func(options computer.BridgeOptions) (Bridge, error) { return computer.NewBridge(options) }
	}
	app.bridge, err = factory(computer.BridgeOptions{Context: owner, DataDir: options.DataDir, Prepare: prepare, Changed: func() { app.broadcastState() }, Event: app.observe})
	if err != nil {
		return nil, err
	}
	lifecycle, err := computer.NewLifecycle(computer.LifecycleOptions{DataDir: options.DataDir, ProjectRoot: options.Root, Host: options.Host})
	if err != nil {
		return nil, err
	}
	app.lifecycle = lifecycle
	app.desktop = NewDesktopLifecycle(DesktopOptions{
		Bridge:    app.bridge,
		Lifecycle: lifecycle,
		Binding:   app.bindingIdentity,
		Configured: func() bool {
			_, err := computer.ReadBinding(options.DataDir)
			return err == nil
		},
		Changed:     app.broadcastState,
		Diagnostics: app.diagnostics,
	})
	app.lease = updates.NewInstallLease(updates.LeaseOptions{Snapshot: app.installationSnapshot, Refresh: app.prepareInstallation, OnFailure: app.releasePrepared, OnRelease: app.releasePrepared, Now: options.Now})
	vault, err := backups.NewVault(backups.VaultOptions{DataDir: options.DataDir, Protection: options.Protector, Executable: options.Executable, Transform: options.BackupTransform})
	if err != nil {
		return nil, err
	}
	transport := options.BackupTransport
	if transport == nil {
		transport, err = backups.NewVMTransport(backups.VMTransportOptions{Bridge: app.bridge, Binding: func() (computer.Binding, error) { return computer.ReadBinding(options.DataDir) }, Version: func() *string {
			if app.deployer == nil {
				return nil
			}
			status := app.deployer.Status()
			if !status.Confirmed {
				return nil
			}
			return status.RunningVersion
		}})
		if err != nil {
			return nil, err
		}
	}
	app.backups, err = backups.NewManager(backups.ManagerOptions{Context: owner, DataDir: options.DataDir, Vault: vault, Transport: transport, Automatic: !options.PrepareOnly, Allowed: app.backgroundAllowed, Changed: func() {
		app.events.publish("backups", struct {
			Changed bool `json:"changed"`
		}{true})
	}, Now: options.Now})
	if err != nil {
		return nil, err
	}

	if options.Fonts == nil {
		app.options.Fonts = func(ctx context.Context) (settings.FontInventory, error) {
			return settings.ListSystemFonts(ctx, settings.FontOptions{Platform: options.Host.OS})
		}
	}
	app.handler = app.auth.Middleware(http.HandlerFunc(app.serve), nil)
	app.wg.Add(1)
	go app.cacheLoop()
	app.diagnostics.Log("service.started", diagnostics.Fields{Version: options.Version, Role: "controller"})
	return app, nil
}

func (app *App) Handler() http.Handler { return app.handler }
func (app *App) bindingIdentity() string {
	binding, err := computer.ReadBinding(app.options.DataDir)
	if err != nil {
		return ""
	}

	return computer.BindingIdentity(binding)
}

func (app *App) backgroundAllowed() bool {
	app.mu.Lock()
	closed, manual := app.closed, app.manual || app.connectionPending
	started := app.started
	app.mu.Unlock()
	if closed || !started || manual || app.options.PrepareOnly {
		return false
	}

	if app.desktop != nil && app.desktop.Blocked() {
		return false
	}

	if app.provisioning != nil && app.provisioning.Snapshot().Running {
		return false
	}

	return app.lease == nil || app.lease.Current() == nil
}

func (app *App) Snapshot() contracts.WorkerSnapshot {
	app.mu.Lock()
	raw, _ := json.Marshal(app.cached)
	configuration := app.configuration
	lastSaved := app.lastSaved
	manual := app.manual
	profileError := app.profileError
	app.mu.Unlock()
	var state contracts.WorkerSnapshot
	if json.Unmarshal(raw, &state) != nil {
		state = emptyWorkerSnapshot()
	}
	state.Mode = "vm-controller"
	state.Settings.Language = configuration.Language
	state.Settings.Notifications = configuration.Notifications
	state.Settings.ShowWorkSummary = configuration.ShowWorkSummary
	state.Settings.ShowCallCaptions = configuration.ShowCallCaptions
	if state.Settings.Extra == nil {
		state.Settings.Extra = contracts.RawObject{}
	}
	appearanceRaw, _ := json.Marshal(configuration.Appearance)
	appearance, _ := contracts.DecodeObject(appearanceRaw, controllerConfigLimit)
	for key, value := range appearance {
		state.Settings.Extra[key] = value
	}
	binding, bindErr := computer.ReadBinding(app.options.DataDir)
	if bindErr == nil {
		bindingRaw, _ := json.Marshal(binding)
		_ = json.Unmarshal(bindingRaw, &state.Settings.VM)
	} else {
		state.Settings.VM = contracts.VMSettings{User: "dant", Port: 22}
	}
	status := contracts.ConnectionStatusOffline
	if app.bridge != nil {
		status = app.bridge.Status()
	}

	if status != contracts.ConnectionStatusOnline {
		state.Worker.Status = status
	}

	if profileError != nil {
		state.Worker.Error = contracts.Some(*profileError)
	}
	key, _ := app.voiceKeys.Status()
	if state.Worker.Realtime == nil {
		state.Worker.Realtime = contracts.RawObject{}
	}
	state.Worker.Realtime["key"], _ = json.Marshal(key)
	state.Worker.Realtime["api"], _ = json.Marshal(struct {
		Available bool   `json:"available"`
		Billing   string `json:"billing"`
	}{key.Configured, "api"})
	if state.Extra == nil {
		state.Extra = contracts.RawObject{}
	}
	phase := contracts.DesktopPhaseIdle
	if app.desktop != nil {
		phase = app.desktop.Phase()
	}
	var serviceUpdate *computer.DeploymentStatus
	if app.deployer != nil {
		value := app.deployer.Status()
		value.Confirmed = value.Confirmed && status == contracts.ConnectionStatusOnline
		serviceUpdate = &value
	}
	state.Extra["controller"], _ = json.Marshal(struct {
		Status            contracts.ConnectionStatus `json:"status"`
		Authority         string                     `json:"authority"`
		VMConfigured      bool                       `json:"vmConfigured"`
		UpdatesPaused     bool                       `json:"updatesPaused"`
		DesktopTransition contracts.DesktopPhase     `json:"desktopTransition"`
		ServiceUpdateBusy bool                       `json:"serviceUpdateBusy"`
		Cached            bool                       `json:"cached"`
		UpdatedAt         *int64                     `json:"updatedAt"`
		Error             *string                    `json:"error"`
		ServiceUpdate     *computer.DeploymentStatus `json:"serviceUpdate"`
	}{status, "vm", bindErr == nil, configuration.ServiceUpdatesPaused, phase, manual, status != contracts.ConnectionStatusOnline, optionalTimestamp(lastSaved), profileError, serviceUpdate})
	if app.provisioning != nil {
		state.Extra["provisioning"], _ = json.Marshal(app.provisioning.Snapshot())
	}
	app.syncCaptions(state)
	state.Extra["callCaption"], _ = json.Marshal(app.callCaptions.Snapshot())
	return state
}

func optionalTimestamp(value int64) *int64 {
	if value == 0 {
		return nil
	}

	return &value
}

func (app *App) broadcastState() {
	app.mu.Lock()
	ready := !app.closed && app.bridge != nil && app.voiceKeys != nil
	app.mu.Unlock()
	if ready {
		app.events.publish("state", app.Snapshot())
	}
}

func (app *App) observe(event computer.BridgeEvent) {
	if app.bridge == nil || event.Generation != app.bridge.Generation() {
		return
	}
	app.mu.Lock()
	closed := app.closed
	app.mu.Unlock()
	if closed {
		return
	}

	if event.Type == "state" {
		var state contracts.WorkerSnapshot
		if json.Unmarshal(event.Data, &state) != nil {
			return
		}
		caption := captions.ReadCaption(state.Extra["callCaption"])
		delete(state.Extra, "callCaption")
		app.mu.Lock()
		if event.Generation != app.bridge.Generation() {
			app.mu.Unlock()
			return
		}
		app.cached = state
		app.mu.Unlock()
		app.syncCaptions(state)
		if caption != nil {
			app.callCaptions.Observe(*caption)
		}
		if app.notifications != nil {
			_ = app.notifications.Observe(app.ctx, state)
		}
		select {
		case app.cacheWake <- struct{}{}:
		default:
		}
		app.broadcastState()
		if app.backups != nil {
			app.backups.Changed()
		}
	} else {
		if event.Type == "realtime" {
			app.syncCaptions(app.bridge.Snapshot())
			var value struct {
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(event.Data, &value) == nil {
				app.callCaptions.Receive(value.Method, value.Params)
			}
		}
		app.events.publish(event.Type, event.Data)
	}
}

func (app *App) syncCaptions(state contracts.WorkerSnapshot) {
	generation := uint64(0)
	connected := false
	if app.bridge != nil {
		generation = app.bridge.Generation()
		connected = app.bridge.Status() == contracts.ConnectionStatusOnline && state.Worker.Status == contracts.ConnectionStatusOnline
	}
	scope, _ := json.Marshal(struct {
		ConversationID string
		Generation     uint64
		Binding        string
	}{state.ConversationID, generation, app.bindingIdentity()})
	app.callCaptions.Sync(state.Call, string(scope), connected)
}

func (app *App) cacheLoop() {
	defer app.wg.Done()
	for {
		select {
		case <-app.ctx.Done():
			return
		case <-app.cacheWake:
			timer := time.NewTimer(2 * time.Second)
			select {
			case <-app.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			app.mu.Lock()
			raw, _ := json.Marshal(app.cached)
			app.mu.Unlock()
			var state contracts.WorkerSnapshot
			if json.Unmarshal(raw, &state) == nil {
				app.saveCache(state)
			}
		}
	}
}

func (app *App) installationSnapshot() updates.InstallationSnapshot {
	state := app.Snapshot()
	progress := app.provisioning.Snapshot()
	return updates.InstallationSnapshot{
		Mode:                "vm-controller",
		Authority:           "vm",
		VMConfigured:        app.bindingIdentity() != "",
		ControllerStatus:    app.bridge.Status(),
		Cached:              app.bridge.Status() != contracts.ConnectionStatusOnline,
		ProvisioningRunning: progress.Running,
		ProvisioningStatus:  progress.Status,
		Worker:              state,
	}
}

func (app *App) prepareInstallation(ctx context.Context) error {
	if app.backups.Busy() {
		return backups.ErrBusy
	}
	restored := false
	if app.bridge.Status() != contracts.ConnectionStatusOnline {
		if _, err := app.lifecycle.Resume(ctx); err != nil {
			return err
		}
		restored = true
	}

	if _, err := app.desktop.Prepare(ctx, PrepareOptions{ManagedVMAlreadyRestored: restored}); err != nil {
		return err
	}

	if app.bridge.Status() == contracts.ConnectionStatusOnline {
		_, err := app.bridge.Refresh(ctx)
		return err
	}

	return nil
}

func (app *App) releasePrepared() {
	if app.desktop != nil && app.desktop.Phase() == contracts.DesktopPhasePaused {
		_ = app.desktop.SetPhase(contracts.DesktopPhaseIdle)
	}
}

func (app *App) Start() {
	app.mu.Lock()
	if app.started || app.closed || app.options.PrepareOnly {
		app.mu.Unlock()
		return
	}
	app.started = true
	app.wg.Add(1)
	app.mu.Unlock()
	app.provisioning.ResumeMonitoring()
	go app.automatic()
}

func (app *App) automatic() {
	defer app.wg.Done()
	ticker := time.NewTicker(controllerAutomaticInterval)
	defer ticker.Stop()
	for {
		app.mu.Lock()
		updatesPaused := app.configuration.ServiceUpdatesPaused
		app.mu.Unlock()
		if !updatesPaused && app.backgroundAllowed() && app.bindingIdentity() != "" && app.bridge.Status() != contracts.ConnectionStatusOnline {
			bounded, stop := context.WithTimeout(app.ctx, controllerDeploymentTimeout)
			_ = app.connect(bounded, false, true)
			stop()
		} else if !updatesPaused && app.backgroundAllowed() && app.bridge.Status() == contracts.ConnectionStatusOnline && app.deployer != nil {
			bounded, stop := context.WithTimeout(app.ctx, controllerDeploymentTimeout)
			_ = app.prepareConnection(bounded)
			stop()
		}
		select {
		case <-app.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (app *App) connect(ctx context.Context, recoverExecutor, deploy bool) error {
	if app.backups != nil && app.backups.Busy() {
		return backups.ErrBusy
	}
	if !app.connectMu.TryLock() {
		return computer.ErrBridgeBusy
	}
	defer app.connectMu.Unlock()
	finish, err := app.enterConnection()
	if err != nil {
		return err
	}
	defer finish()
	if _, err := app.profiles.AutoImport(ctx); err != nil {
		return err
	}

	if app.bridge.Status() != contracts.ConnectionStatusOnline {
		var err error
		if recoverExecutor {
			_, err = app.lifecycle.ResumeForReconnect(ctx)
		} else {
			_, err = app.lifecycle.Resume(ctx)
		}
		if err != nil {
			return err
		}
	}

	if recoverExecutor {
		if _, err := app.desktop.Cancel(ctx, true); err != nil {
			return err
		}
	}

	if err := app.bridge.Connect(ctx, deploy); err != nil {
		return err
	}

	if err := app.syncPreferences(ctx); err != nil {
		return err
	}

	if !recoverExecutor {
		return nil
	}
	state, err := app.bridge.Refresh(ctx)
	if err != nil || state.Worker.Status != contracts.ConnectionStatusOffline {
		return err
	}

	if !computer.ServiceUpdateQuiescent(state, true) {
		return computer.ErrPauseUnconfirmed
	}
	response, err := app.bridge.Request(ctx, http.MethodPost, "/api/connect", http.Header{"Content-Type": []string{"application/json"}}, strings.NewReader(`{"idleRecovery":true}`))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return computer.ErrSessionUnavailable
	}
	state, err = app.bridge.Refresh(ctx)
	if err != nil || state.Worker.Status != contracts.ConnectionStatusOnline {
		return computer.ErrSessionUnavailable
	}

	return nil
}

func (app *App) enterConnection() (func(), error) {
	finish, err := app.lease.Enter()
	if err != nil {
		return nil, err
	}
	app.mu.Lock()
	app.connectionPending = true
	app.mu.Unlock()
	app.broadcastState()
	return func() {
		app.mu.Lock()
		app.connectionPending = false
		app.mu.Unlock()
		finish(false)
		app.broadcastState()
	}, nil
}

func (app *App) prepareConnection(ctx context.Context) error {
	if app.backups != nil && app.backups.Busy() {
		return backups.ErrBusy
	}
	if !app.connectMu.TryLock() {
		return computer.ErrBridgeBusy
	}
	defer app.connectMu.Unlock()
	finish, err := app.enterConnection()
	if err != nil {
		return err
	}
	defer finish()
	return app.bridge.Prepare(ctx)
}

func (app *App) cancelDesktopTransition(ctx context.Context) (DesktopResult, error) {
	restored := app.bridge.Status() != contracts.ConnectionStatusOnline
	if restored {
		if _, err := app.lifecycle.Resume(ctx); err != nil {
			return DesktopResult{}, err
		}
	}

	return app.desktop.Cancel(ctx, restored)
}

func (app *App) Close() {
	app.closeOnce.Do(func() {
		app.mu.Lock()
		app.closed = true
		app.cancel()
		app.mu.Unlock()
		app.events.close()
		if app.backups != nil {
			app.backups.Close()
		}
		if app.provisioning != nil {
			app.provisioning.Close()
		}
		if app.bridge != nil {
			app.bridge.Close()
		}
		if app.desktop != nil {
			app.desktop.Close()
		}
		if app.lease != nil {
			app.lease.Close()
		}
		if app.updates != nil {
			app.updates.Close()
		}
		app.wg.Wait()
		if app.diagnostics != nil {
			_ = app.diagnostics.Close()
		}
	})
}
