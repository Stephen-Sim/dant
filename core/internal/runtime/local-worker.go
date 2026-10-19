package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/history"
)

const ExecutorStopTimeout = 5 * time.Second

type ConversationSource interface {
	Snapshot() contracts.State
}
type WorkerOptions struct {
	Platform              string
	UID                   *int
	Home                  string
	RuntimeID             string
	WorkspaceRoot         string
	GuestOrigin           string
	Environment           []string
	CredentialBridgeToken string
	Client                HTTPDoer
	VerifyRuntime         func(context.Context) error
	Factory               ProcessFactory
	Command               string
	TransformRequest      func(string, contracts.RawObject, []*contracts.ChatMessage) (contracts.RawObject, error)
	SkillContext          func() string
	RunVoiceMessage       func(context.Context, VoiceMessageCommand) ([]byte, error)
	Changed               func()
}
type connectionAttempt struct {
	done   chan struct{}
	cancel context.CancelFunc
	result contracts.RawObject
	err    error
}
type LocalWorker struct {
	ctx             context.Context
	cancel          context.CancelFunc
	source          ConversationSource
	options         WorkerOptions
	mu              sync.Mutex
	generation      uint64
	status          contracts.ConnectionStatus
	lastError       contracts.Optional[string]
	rpc             *RPC
	executor        *Executor
	connecting      *connectionAttempt
	account, models contracts.RawObject
	closed          bool
	monitors        sync.WaitGroup
}

func NewLocalWorker(ctx context.Context, source ConversationSource, options WorkerOptions) (*LocalWorker, error) {
	if source == nil || options.GuestOrigin == "" || ValidateGuestOrigin(options.GuestOrigin) != nil {
		return nil, ErrVMUnavailable
	}
	if options.Platform == "" {
		options.Platform = goruntime.GOOS
	}
	if options.UID == nil {
		uid := os.Geteuid()
		options.UID = &uid
	}
	if options.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, ErrWorkerRole
		}
		options.Home = home
	}
	if options.WorkspaceRoot == "" {
		options.WorkspaceRoot = filepath.Join(options.Home, "dant", "workspaces")
	}
	if options.Factory == nil {
		options.Factory = SpawnExecutor
	}
	if options.Client == nil {
		options.Client = &http.Client{Timeout: GuestTimeout}
	}
	if options.VerifyRuntime == nil {
		options.VerifyRuntime = func(ctx context.Context) error {
			return VerifyVMRuntime(ctx, RuntimeVerification{Platform: options.Platform, UID: *options.UID, GuestOrigin: options.GuestOrigin, Client: options.Client})
		}
	}
	if options.RuntimeID == "" {
		host, err := os.Hostname()
		if err != nil {
			return nil, ErrWorkerRole
		}
		options.RuntimeID = "vm:" + host + ":" + filepath.Base(options.Home)
	}
	lifetime, cancel := context.WithCancel(ctx)
	return &LocalWorker{
		ctx:       lifetime,
		cancel:    cancel,
		source:    source,
		options:   options,
		status:    contracts.ConnectionStatusOffline,
		lastError: contracts.Null[string](),
	}, nil
}

func (value *LocalWorker) RuntimeID() string {
	return value.options.RuntimeID
}

func (value *LocalWorker) WorkspaceRoot() string {
	return value.options.WorkspaceRoot
}

func (value *LocalWorker) DesktopPath() string {
	return filepath.Join(value.options.Home, "dant", "vm", "desktop.py")
}

func (value *LocalWorker) Snapshot() contracts.WorkerState {
	value.mu.Lock()
	defer value.mu.Unlock()
	return contracts.WorkerState{Status: value.status, Error: value.lastError, RuntimeID: value.options.RuntimeID, Generation: value.generation, Account: cloneObject(value.account), Models: append(json.RawMessage(nil), value.models["data"]...)}
}

func (value *LocalWorker) current(generation uint64, conversation string, rpc *RPC) bool {
	value.mu.Lock()
	current := generation == value.generation && (rpc == nil || value.rpc == rpc) && value.ctx.Err() == nil
	value.mu.Unlock()
	return current && value.conversationID() == conversation
}

func (value *LocalWorker) conversationID() string {
	if source, ok := value.source.(interface{ ConversationID() string }); ok {
		return source.ConversationID()
	}
	return value.source.Snapshot().ConversationID
}

func (value *LocalWorker) Connect(ctx context.Context) (contracts.RawObject, error) {
	if value.options.Platform != "linux" || *value.options.UID <= 0 {
		return nil, ErrWorkerRole
	}
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return nil, ErrDisconnected
	}
	if attempt := value.connecting; attempt != nil {
		value.mu.Unlock()
		select {
		case <-attempt.done:
			return attempt.result, attempt.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	value.generation++
	generation := value.generation
	previousRPC, previousExecutor := value.rpc, value.executor
	value.rpc = nil
	value.status = contracts.ConnectionStatusConnecting
	value.lastError = contracts.Null[string]()
	value.account, value.models = nil, nil
	connectionContext, cancel := context.WithCancel(ctx)
	defer cancel()
	attempt := &connectionAttempt{done: make(chan struct{}), cancel: cancel}
	value.connecting = attempt
	value.mu.Unlock()
	value.changed()
	if previousRPC != nil {
		previousRPC.Close()
	}
	if previousExecutor != nil {
		if previousExecutor.Stop != nil {
			_ = previousExecutor.Stop()
		}
		stopContext, cancel := context.WithTimeout(connectionContext, ExecutorStopTimeout)
		select {
		case <-previousExecutor.Stopped:
		case <-stopContext.Done():
			cancel()
			value.finishConnect(generation, attempt, nil, ErrStopUnconfirmed)
			return nil, ErrStopUnconfirmed
		}
		cancel()
	}
	conversation := value.conversationID()
	if conversation == "" {
		value.finishConnect(generation, attempt, nil, ErrConnectionChanged)
		return nil, ErrConnectionChanged
	}
	result, err := value.open(connectionContext, generation, conversation)
	value.finishConnect(generation, attempt, result, err)
	return result, err
}

func (value *LocalWorker) finishConnect(generation uint64, attempt *connectionAttempt, result contracts.RawObject, err error) {
	value.mu.Lock()
	attempt.result = result
	attempt.err = err
	if value.connecting == attempt {
		value.connecting = nil
	}
	if value.generation == generation {
		if err != nil {
			value.status = contracts.ConnectionStatusOffline
			value.lastError = contracts.Some("executor_connection_failed")
		} else {
			value.status = contracts.ConnectionStatusOnline
			value.lastError = contracts.Null[string]()
		}
	}
	close(attempt.done)
	value.mu.Unlock()
	value.changed()
}

func (value *LocalWorker) open(ctx context.Context, generation uint64, conversation string) (contracts.RawObject, error) {
	if err := value.options.VerifyRuntime(ctx); err != nil {
		return nil, err
	}
	if !value.current(generation, conversation, nil) {
		return nil, ErrConnectionChanged
	}
	if _, err := files.OrdinaryDirectory(value.options.WorkspaceRoot, true); err != nil {
		return nil, ErrWorkerRole
	}
	command := value.options.Command
	if command == "" {
		for _, candidate := range []string{filepath.Join(value.options.Home, ".local", "bin", "codex"), "/usr/local/bin/codex", "/usr/bin/codex"} {
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				command = candidate
				break
			}
		}
	}
	if command == "" {
		return nil, ErrDisconnected
	}
	jsonString := func(value any) string {
		raw, _ := json.Marshal(value)
		return string(raw)
	}
	args := []string{"-c", "features.realtime_conversation=true", "-c", "mcp_servers.dant_desktop.command=" + jsonString("/usr/bin/python3"), "-c", "mcp_servers.dant_desktop.args=" + jsonString([]string{filepath.Join(value.options.Home, "dant", "vm", "desktop_mcp.py"), "--output-dir", filepath.Join(value.options.WorkspaceRoot, conversation, "output")}), "-c", "mcp_servers.dant_desktop.env_vars=" + jsonString([]string{"DANT_CREDENTIAL_BRIDGE_TOKEN", "DANT_CONTROL_FILE"}), "-c", "mcp_servers.dant_desktop.tool_timeout_sec=660", "app-server", "--listen", "stdio://"}
	environment := executorEnvironment(value.options)
	executor, err := value.options.Factory(value.ctx, ProcessOptions{Command: command, Args: args, Directory: value.options.WorkspaceRoot, Environment: environment})
	if err != nil {
		return nil, err
	}
	if executor == nil || executor.RPC == nil || executor.Stopped == nil {
		if executor != nil && executor.RPC != nil {
			executor.RPC.Close()
		}
		return nil, ErrDisconnected
	}
	value.mu.Lock()
	if value.generation != generation {
		value.mu.Unlock()
		executor.RPC.Close()
		return nil, ErrConnectionChanged
	}
	value.rpc = executor.RPC
	value.executor = executor
	value.mu.Unlock()
	rpc := executor.RPC
	accountEvents, unsubscribe, err := rpc.subscribeEvents(isAccountEvent)
	if err != nil {
		rpc.Close()
		return nil, err
	}
	fail := func(err error) (contracts.RawObject, error) {
		unsubscribe()
		rpc.Close()
		value.mu.Lock()
		if value.rpc == rpc {
			value.rpc = nil
		}
		value.mu.Unlock()
		return nil, err
	}
	initialize := contracts.RawObject{"clientInfo": json.RawMessage(`{"name":"dant","title":"dant","version":"0.1.0"}`), "capabilities": json.RawMessage(`{"experimentalApi":true}`)}
	if _, err = rpc.Request(ctx, "initialize", initialize); err != nil {
		return fail(err)
	}
	if !value.current(generation, conversation, rpc) {
		return fail(ErrConnectionChanged)
	}
	if err = rpc.Notify(ctx, "initialized", nil); err != nil {
		return fail(err)
	}
	account, err := rpc.Request(ctx, "account/read", nil)
	if err != nil {
		return fail(err)
	}
	if !value.current(generation, conversation, rpc) {
		return fail(ErrConnectionChanged)
	}
	models, err := rpc.Request(ctx, "model/list", nil)
	if err != nil {
		return fail(err)
	}
	if !value.current(generation, conversation, rpc) {
		return fail(ErrConnectionChanged)
	}
	value.mu.Lock()
	if value.closed || value.generation != generation || value.rpc != rpc {
		value.mu.Unlock()
		return fail(ErrConnectionChanged)
	}
	value.models = models
	value.account = account
	value.monitors.Add(1)
	value.mu.Unlock()
	go value.monitorAccount(rpc, generation, accountEvents, unsubscribe)
	return account, nil
}

func (value *LocalWorker) Disconnect() {
	value.mu.Lock()
	value.generation++
	if value.connecting != nil {
		value.connecting.cancel()
		value.connecting = nil
	}
	rpc := value.rpc
	value.rpc = nil
	value.status = contracts.ConnectionStatusOffline
	value.account = nil
	value.models = nil
	value.mu.Unlock()
	if rpc != nil {
		rpc.Close()
	}
	value.changed()
}

func (value *LocalWorker) Close() {
	value.mu.Lock()
	value.closed = true
	value.mu.Unlock()
	value.cancel()
	value.Disconnect()
}

func (value *LocalWorker) CloseContext(ctx context.Context) error {
	value.Close()
	confirmed, err := value.TerminateConfirmed(ctx)
	if err != nil || !confirmed {
		return ErrStopUnconfirmed
	}
	finished := make(chan struct{})
	go func() { value.monitors.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-ctx.Done():
		return ErrStopUnconfirmed
	}
	return nil
}

func (value *LocalWorker) TerminateConfirmed(ctx context.Context) (bool, error) {
	value.mu.Lock()
	executor := value.executor
	rpc := value.rpc
	value.mu.Unlock()
	if executor == nil {
		return true, nil
	}
	if rpc != nil {
		rpc.Close()
	}
	if executor.Stop != nil {
		_ = executor.Stop()
	}
	deadline, cancel := context.WithTimeout(ctx, ExecutorStopTimeout)
	defer cancel()
	select {
	case <-executor.Stopped:
		return true, nil
	case <-deadline.Done():
		return false, ErrStopUnconfirmed
	}
}

func (value *LocalWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	return value.RequestGuarded(ctx, method, params, nil)
}

func (value *LocalWorker) RequestGuarded(ctx context.Context, method string, params contracts.RawObject, guard func() error) (contracts.RawObject, error) {
	value.mu.Lock()
	rpc := value.rpc
	generation := value.generation
	status := value.status
	value.mu.Unlock()
	if status != contracts.ConnectionStatusOnline || rpc == nil {
		return nil, ErrDisconnected
	}
	conversation := value.source.Snapshot()
	skillContext := ""
	if value.options.SkillContext != nil && (method == "turn/start" || method == "turn/steer" || method == "thread/realtime/start") {
		skillContext = value.options.SkillContext()
	}
	params = history.InjectChatReferences(method, params, conversation.Messages, skillContext)
	if value.options.TransformRequest != nil {
		var err error
		params, err = value.options.TransformRequest(method, params, conversation.Messages)
		if err != nil {
			return nil, err
		}
	}
	result, err := rpc.RequestGuarded(ctx, method, params, func() error {
		if !value.current(generation, conversation.ConversationID, rpc) {
			return ErrConnectionChanged
		}
		if guard != nil {
			return guard()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !value.current(generation, conversation.ConversationID, rpc) {
		return nil, &OperationError{Cause: ErrConnectionChanged, UnknownOutcome: true}
	}
	if method == "account/logout" {
		value.mu.Lock()
		if value.generation == generation && value.rpc == rpc {
			value.account = contracts.RawObject{"account": json.RawMessage("null")}
		}
		value.mu.Unlock()
		value.changed()
	}
	return result, nil
}

func (value *LocalWorker) Reply(ctx context.Context, id RPCID, result json.RawMessage) error {
	value.mu.Lock()
	rpc := value.rpc
	value.mu.Unlock()
	if rpc == nil {
		return ErrDisconnected
	}
	return rpc.Reply(ctx, id, result)
}

func (value *LocalWorker) ReplyError(ctx context.Context, id RPCID, code int, message string) error {
	value.mu.Lock()
	rpc := value.rpc
	value.mu.Unlock()
	if rpc == nil {
		return ErrDisconnected
	}
	return rpc.ReplyError(ctx, id, code, message)
}

func (value *LocalWorker) SubscribeEvents() (
	<-chan Event,
	func(),
	error) {
	value.mu.Lock()
	rpc := value.rpc
	value.mu.Unlock()
	if rpc == nil {
		return nil, nil, ErrDisconnected
	}
	return rpc.SubscribeEvents()
}

func (value *LocalWorker) Guest(ctx context.Context, route string, body json.RawMessage) (*http.Response, error) {
	value.mu.Lock()
	status := value.status
	value.mu.Unlock()
	readOnly := value.options.Platform == "linux" && route == "/screen" && len(body) == 0
	if status != contracts.ConnectionStatusOnline && !readOnly {
		return nil, ErrDisconnected
	}
	switch route {
	case "/screen", "/input", "/control", "/file", "/read-file":
	default:
		return nil, ErrInvalidProtocol
	}
	method := http.MethodGet
	var reader io.Reader
	if len(body) > 0 {
		if !json.Valid(body) {
			return nil, ErrInvalidProtocol
		}
		method = http.MethodPost
		reader = strings.NewReader(string(body))
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(value.options.GuestOrigin, "/")+route, reader)
	if err != nil {
		return nil, ErrInvalidProtocol
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := value.options.Client.Do(request)
	if err != nil {
		return nil, ErrDesktopUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, ErrDesktopUnavailable
	}
	return response, nil
}
