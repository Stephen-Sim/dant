package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/coder/websocket"
)

const workerAPIPort = 4317
const vmSessionReadyTimeout = 30 * time.Second
const vmSessionRequestTimeout = 2 * time.Second
const vmSessionRetryDelay = 300 * time.Millisecond
const vmRequestTimeout = 60 * time.Second
const vmStateMaxBytes = 8 * 1024 * 1024

var ErrBridgeClosed = errors.New("vm_bridge_closed")
var ErrBridgeBusy = errors.New("vm_bridge_busy")
var ErrBridgeOffline = errors.New("vm_bridge_offline")
var ErrBridgeChanged = errors.New("vm_connection_changed")
var ErrSessionUnavailable = errors.New("vm_session_unavailable")

type RequestError struct{ UnknownOutcome bool }

func (err *RequestError) Error() string {
	if err.UnknownOutcome {
		return "vm_request_unconfirmed"
	}

	return "vm_request_failed"
}

type Tunnel interface {
	Endpoint() string
	Done() <-chan struct{}
	Stop()
}

type sshTunnel struct {
	process  *platform.Process
	endpoint string
}

func (tunnel *sshTunnel) Endpoint() string      { return tunnel.endpoint }
func (tunnel *sshTunnel) Done() <-chan struct{} { return tunnel.process.Done() }
func (tunnel *sshTunnel) Stop()                 { tunnel.process.Stop() }

type BridgeEvent struct {
	Generation uint64
	Type       string
	Data       json.RawMessage
}

type BridgeOptions struct {
	Context    context.Context
	DataDir    string
	HTTP       *http.Client
	OpenTunnel func(context.Context, Binding) (Tunnel, error)
	Prepare    func(context.Context, Binding) error
	Changed    func()
	Event      func(BridgeEvent)
}

type bridgeSession struct {
	generation uint64
	binding    Binding
	tunnel     Tunnel
	ctx        context.Context
	cancel     context.CancelFunc
	token      string
	endpoint   string
}

type VMBridge struct {
	mu         sync.Mutex
	connectMu  sync.Mutex
	pauseMu    sync.Mutex
	options    BridgeOptions
	ctx        context.Context
	cancel     context.CancelFunc
	generation uint64
	status     contracts.ConnectionStatus
	cached     contracts.WorkerSnapshot
	session    *bridgeSession
	closed     bool
	wg         sync.WaitGroup
}

func NewBridge(options BridgeOptions) (*VMBridge, error) {
	if options.Context == nil || !filepath.IsAbs(options.DataDir) {
		return nil, ErrBinding
	}

	if options.HTTP == nil {
		options.HTTP = &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("vm_redirect_rejected") }}
	}

	if options.OpenTunnel == nil {
		options.OpenTunnel = openSSHTunnel
	}

	if options.Changed == nil {
		options.Changed = func() {}
	}

	if options.Event == nil {
		options.Event = func(BridgeEvent) {}
	}
	ctx, cancel := context.WithCancel(options.Context)
	return &VMBridge{
		options: options,
		ctx:     ctx,
		cancel:  cancel,
		status:  contracts.ConnectionStatusOffline,
		cached: contracts.WorkerSnapshot{
			Worker:      contracts.WorkerState{Status: contracts.ConnectionStatusOffline},
			Messages:    []*contracts.ChatMessage{},
			WorkTasks:   []contracts.WorkRecord{},
			Queue:       []string{},
			Completions: []contracts.Completion{},
			Settings: contracts.Settings{
				Language: "zh", Voice: "marin", ShowCallCaptions: true,
				VM: contracts.VMSettings{User: "dant", Port: 22},
			},
		},
	}, nil
}

func openSSHTunnel(ctx context.Context, binding Binding) (Tunnel, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, ErrSessionUnavailable
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	args := SSHArgs(binding)
	args = append(args, "-N", "-L", strconv.Itoa(port)+":127.0.0.1:"+strconv.Itoa(workerAPIPort), "-o", "ExitOnForwardFailure=yes", binding.User+"@"+binding.Host)
	process, err := platform.StartProcess(ctx, "ssh", args)
	if err != nil {
		return nil, ErrSessionUnavailable
	}

	return &sshTunnel{process: process, endpoint: "http://127.0.0.1:" + strconv.Itoa(port)}, nil
}

func validEndpoint(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	port, err := strconv.Atoi(parsed.Port())
	return ip != nil && ip.IsLoopback() && err == nil && port > 0 && port <= 65535
}

func (bridge *VMBridge) Status() contracts.ConnectionStatus {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.status
}

func (bridge *VMBridge) Generation() uint64 {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.generation
}

func (bridge *VMBridge) Snapshot() contracts.WorkerSnapshot {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	raw, err := json.Marshal(bridge.cached)
	if err != nil {
		return bridge.cached
	}
	var copy contracts.WorkerSnapshot
	if json.Unmarshal(raw, &copy) != nil {
		return bridge.cached
	}

	return copy
}

func (bridge *VMBridge) current(session *bridgeSession) bool {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return !bridge.closed && bridge.session == session && bridge.generation == session.generation
}

func (bridge *VMBridge) Prepare(ctx context.Context) error {
	bridge.mu.Lock()
	if bridge.closed {
		bridge.mu.Unlock()
		return ErrBridgeClosed
	}
	bridge.wg.Add(1)
	bridge.mu.Unlock()
	defer bridge.wg.Done()
	operation, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(bridge.ctx, cancel)
	defer func() {
		stop()
		cancel()
	}()
	binding, err := ReadBinding(bridge.options.DataDir)
	if err != nil {
		return err
	}

	if bridge.options.Prepare == nil {
		return ErrProviderUnavailable
	}

	return bridge.options.Prepare(operation, binding)
}

func (bridge *VMBridge) Connect(ctx context.Context, deploy bool) error {
	if !bridge.connectMu.TryLock() {
		return ErrBridgeBusy
	}
	defer bridge.connectMu.Unlock()
	bridge.mu.Lock()
	if bridge.closed {
		bridge.mu.Unlock()
		return ErrBridgeClosed
	}
	bridge.wg.Add(1)
	bridge.mu.Unlock()
	defer bridge.wg.Done()
	if deploy {
		if err := bridge.Prepare(ctx); err != nil {
			return err
		}
	}
	binding, err := ReadBinding(bridge.options.DataDir)
	if err != nil {
		return err
	}
	bridge.Disconnect()
	owner, cancel := context.WithCancel(bridge.ctx)
	tunnel, err := bridge.options.OpenTunnel(owner, binding)
	if err != nil {
		cancel()
		return err
	}

	if !validEndpoint(tunnel.Endpoint()) {
		cancel()
		tunnel.Stop()
		return ErrSessionUnavailable
	}
	bridge.mu.Lock()
	if bridge.closed {
		bridge.mu.Unlock()
		cancel()
		tunnel.Stop()
		return ErrBridgeClosed
	}
	generation := bridge.generation
	session := &bridgeSession{generation: generation, binding: binding, tunnel: tunnel, ctx: owner, cancel: cancel, endpoint: tunnel.Endpoint()}
	bridge.session = session
	bridge.status = contracts.ConnectionStatusConnecting
	bridge.mu.Unlock()
	bridge.options.Changed()
	ready, cancelReady := context.WithTimeout(ctx, vmSessionReadyTimeout)
	stop := context.AfterFunc(owner, cancelReady)
	defer func() {
		stop()
		cancelReady()
	}()
	for {
		if !bridge.current(session) {
			return ErrBridgeChanged
		}
		token, err := bridge.sessionToken(ready, session.endpoint)
		if err == nil {
			session.token = token
			break
		}
		select {
		case <-ready.Done():
			bridge.fail(session)
			return ErrSessionUnavailable
		case <-tunnel.Done():
			bridge.fail(session)
			return ErrSessionUnavailable
		case <-time.After(vmSessionRetryDelay):
		}
	}
	bridge.mu.Lock()
	if bridge.session != session || bridge.closed {
		bridge.mu.Unlock()
		return ErrBridgeChanged
	}
	bridge.status = contracts.ConnectionStatusOnline
	bridge.mu.Unlock()
	if _, err := bridge.Refresh(ready); err != nil {
		bridge.fail(session)
		return err
	}

	if !bridge.current(session) {
		return ErrBridgeChanged
	}
	bridge.mu.Lock()
	bridge.wg.Add(1)
	bridge.mu.Unlock()
	go bridge.events(session)
	bridge.options.Changed()
	return nil
}

func (bridge *VMBridge) sessionToken(ctx context.Context, endpoint string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, vmSessionRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/api/session", nil)
	if err != nil {
		return "", ErrSessionUnavailable
	}
	response, err := bridge.options.HTTP.Do(request)
	if err != nil {
		return "", ErrSessionUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", ErrSessionUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	if err != nil || len(raw) > 8192 {
		return "", ErrSessionUnavailable
	}

	if _, err := contracts.DecodeObject(raw, 8192); err != nil {
		return "", ErrSessionUnavailable
	}
	var value struct {
		Token string `json:"token"`
	}

	if json.Unmarshal(raw, &value) != nil || len(value.Token) == 0 || len(value.Token) > 256 || strings.ContainsAny(value.Token, "\x00\r\n") {
		return "", ErrSessionUnavailable
	}

	return value.Token, nil
}

type responseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
	stop   func() bool
	once   sync.Once
}

func (body *responseBody) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(func() {
		body.stop()
		body.cancel()
	})
	return err
}

func (bridge *VMBridge) Request(ctx context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
	parsed, err := url.ParseRequestURI(route)
	if err != nil || !strings.HasPrefix(route, "/api/") || strings.HasPrefix(route, "//") || strings.Contains(route, "://") || parsed.IsAbs() || parsed.Host != "" {
		return nil, ErrBinding
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return nil, ErrBinding
	}
	query.Del("token")
	parsed.RawQuery = query.Encode()
	bridge.mu.Lock()
	session := bridge.session
	online := bridge.status == contracts.ConnectionStatusOnline && !bridge.closed
	bridge.mu.Unlock()
	if !online || session == nil {
		return nil, ErrBridgeOffline
	}
	requestContext, cancel := context.WithCancel(ctx)
	if _, bounded := ctx.Deadline(); !bounded {
		cancel()
		requestContext, cancel = context.WithTimeout(ctx, vmRequestTimeout)
	}
	stop := context.AfterFunc(session.ctx, cancel)
	request, err := http.NewRequestWithContext(requestContext, method, session.endpoint+parsed.String(), body)
	if err != nil {
		stop()
		cancel()
		return nil, ErrBinding
	}

	if contentType := headers.Get("Content-Type"); contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("X-Dant-Token", session.token)
	response, err := bridge.options.HTTP.Do(request)
	if err != nil {
		stop()
		cancel()
		return nil, &RequestError{UnknownOutcome: method != "GET" && method != "HEAD"}
	}

	if !bridge.current(session) {
		response.Body.Close()
		stop()
		cancel()
		return nil, &RequestError{UnknownOutcome: method != "GET" && method != "HEAD"}
	}
	response.Body = &responseBody{ReadCloser: response.Body, cancel: cancel, stop: stop}
	return response, nil
}

func (bridge *VMBridge) Refresh(ctx context.Context) (contracts.WorkerSnapshot, error) {
	generation := bridge.Generation()
	response, err := bridge.Request(ctx, http.MethodGet, "/api/state", nil, nil)
	if err != nil {
		return contracts.WorkerSnapshot{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return contracts.WorkerSnapshot{}, ErrSessionUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, vmStateMaxBytes+1))
	if err != nil || len(raw) > vmStateMaxBytes {
		return contracts.WorkerSnapshot{}, ErrSessionUnavailable
	}

	if _, err := contracts.DecodeObject(raw, vmStateMaxBytes); err != nil {
		return contracts.WorkerSnapshot{}, ErrSessionUnavailable
	}
	var state contracts.WorkerSnapshot
	if json.Unmarshal(raw, &state) != nil || !state.Worker.Status.Valid() {
		return contracts.WorkerSnapshot{}, ErrSessionUnavailable
	}
	bridge.mu.Lock()
	if bridge.closed || bridge.generation != generation || bridge.status != contracts.ConnectionStatusOnline {
		bridge.mu.Unlock()
		return contracts.WorkerSnapshot{}, ErrBridgeChanged
	}
	bridge.cached = state
	bridge.mu.Unlock()
	bridge.options.Event(BridgeEvent{Generation: generation, Type: "state", Data: append(json.RawMessage{}, raw...)})
	return state, nil
}

func (bridge *VMBridge) events(session *bridgeSession) {
	defer bridge.wg.Done()
	endpoint := "ws" + strings.TrimPrefix(session.endpoint, "http") + "/events?token=" + url.QueryEscape(session.token)
	connection, _, err := websocket.Dial(session.ctx, endpoint, &websocket.DialOptions{HTTPClient: bridge.options.HTTP})
	if err != nil {
		bridge.fail(session)
		return
	}
	defer connection.CloseNow()
	connection.SetReadLimit(vmStateMaxBytes)
	for {
		kind, raw, err := connection.Read(session.ctx)
		if err != nil {
			bridge.fail(session)
			return
		}
		if kind != websocket.MessageText || !bridge.current(session) {
			continue
		}
		if _, err := contracts.DecodeObject(raw, vmStateMaxBytes); err != nil {
			continue
		}
		var event struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &event) != nil || event.Type == "" || len(event.Type) > 128 {
			continue
		}
		if event.Type == "state" {
			var state contracts.WorkerSnapshot
			if json.Unmarshal(event.Data, &state) != nil || !state.Worker.Status.Valid() {
				continue
			}
			bridge.mu.Lock()
			if bridge.session != session || bridge.closed {
				bridge.mu.Unlock()
				return
			}
			bridge.cached = state
			bridge.mu.Unlock()
		}
		bridge.options.Event(BridgeEvent{Generation: session.generation, Type: event.Type, Data: append(json.RawMessage{}, event.Data...)})
	}
}

func (bridge *VMBridge) fail(session *bridgeSession) {
	bridge.mu.Lock()
	if bridge.closed || bridge.session != session {
		bridge.mu.Unlock()
		return
	}
	bridge.session = nil
	bridge.status = contracts.ConnectionStatusOffline
	bridge.mu.Unlock()
	session.cancel()
	session.tunnel.Stop()
	bridge.options.Changed()
}

func (bridge *VMBridge) Disconnect() {
	bridge.mu.Lock()
	session := bridge.session
	bridge.session = nil
	bridge.generation++
	bridge.status = contracts.ConnectionStatusOffline
	bridge.mu.Unlock()
	if session != nil {
		session.cancel()
		session.tunnel.Stop()
	}
	bridge.options.Changed()
}

func (bridge *VMBridge) Close() {
	bridge.mu.Lock()
	bridge.closed = true
	bridge.cancel()
	bridge.mu.Unlock()
	bridge.Disconnect()
	bridge.wg.Wait()
}
