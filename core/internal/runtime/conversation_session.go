package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const conversationLifetime = 5 * time.Minute
const conversationUserAgentPrefix = "dant/" + conversationCodexVersion + " ("
const conversationUserAgentBytes = 1024
const conversationCodexHome = "/conversation/config"

// ConversationSession has a separate process and configuration namespace. Its
// bearer uses the original provider's endpoint and account, with no managed
// login, inherited configuration, cloud policy identity, or secret persistence.
type ConversationSession struct {
	worker                   *LocalWorker
	executor                 *Executor
	ctx                      context.Context
	cancel                   context.CancelFunc
	origin                   *RPC
	generation, accountEpoch uint64
	conversationID, root     string
	directory                *conversationDirectory
	isCurrent                func() bool
	once                     sync.Once
	done                     chan struct{}
	subscriptionsMu          sync.Mutex
	subscriptionsClosed      bool
	subscriptions            sync.WaitGroup
}

func (value *LocalWorker) OpenConversation(ctx context.Context, conversationID string, isCurrent func() bool) (*ConversationSession, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	value.mu.Lock()
	if value.closed || value.status != contracts.ConnectionStatusOnline || value.rpc == nil || value.conversationOpening || value.conversationSession != nil || isCurrent == nil {
		value.mu.Unlock()
		return nil, ErrDisconnected
	}
	value.conversationOpening = true
	value.monitors.Add(1)
	origin, generation, accountEpoch := value.rpc, value.generation, value.accountEpoch
	catalog := append(json.RawMessage(nil), value.models["data"]...)
	value.mu.Unlock()
	retainedOpening := false
	defer func() {
		defer value.monitors.Done()
		value.mu.Lock()
		if !retainedOpening {
			value.conversationOpening = false
		}
		value.mu.Unlock()
	}()

	guard := func() error {
		if !value.current(generation, conversationID, origin) || !isCurrent() {
			return ErrConnectionChanged
		}
		value.mu.Lock()
		current := value.accountEpoch == accountEpoch && !value.closed
		value.mu.Unlock()
		if !current {
			return ErrConnectionChanged
		}
		return nil
	}
	if err := guard(); err != nil {
		return nil, err
	}
	if err := value.options.VerifyRuntime(ctx); err != nil {
		return nil, err
	}
	// These options alter the original provider's routing or account context.
	// Do not silently substitute the default endpoint or a different project.
	for _, entry := range value.options.Environment {
		key, setting, _ := strings.Cut(entry, "=")
		if setting != "" && (key == "OPENAI_BASE_URL" || key == "OPENAI_ORGANIZATION" || key == "OPENAI_PROJECT" || key == "OPENAI_ORG_ID" || key == "OPENAI_PROJECT_ID") {
			return nil, ErrInvalidProtocol
		}
	}
	auth, err := readConversationAuth(ctx, origin, guard, filepath.Join(value.options.WorkspaceRoot, conversationID))
	if err != nil {
		return nil, err
	}
	account, err := origin.RequestGuarded(ctx, "account/read", nil, guard)
	if err != nil {
		return nil, err
	}
	if err := validateConversationRouting(auth, account); err != nil {
		return nil, err
	}
	if auth.model == "" {
		auth.model, err = conversationCatalogDefault(catalog)
		if err != nil {
			return nil, err
		}
	}
	command := value.options.Command
	if command == "" {
		for _, candidate := range []string{filepath.Join(value.options.Home, ".local", "bin", "codex"), "/usr/local/bin/codex", "/usr/bin/codex"} {
			if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
				command = candidate
				break
			}
		}
	}
	directory, err := createConversationDirectory()
	if err != nil {
		return nil, err
	}
	root := directory.path
	options, err := conversationProcessOptions(root, command, auth.arguments())
	if err != nil {
		directory.remove()
		return nil, err
	}
	options.Environment = append(options.Environment, conversationTokenEnv+"="+auth.token)
	if auth.account != "" {
		options.Environment = append(options.Environment, conversationAccountEnv+"="+auth.account)
	}
	lifetime, cancel := context.WithTimeout(value.ctx, conversationLifetime)
	if err := guard(); err != nil {
		cancel()
		directory.remove()
		return nil, err
	}
	if !directory.current() {
		cancel()
		return nil, ErrWorkerRole
	}
	executor, err := value.options.Factory(lifetime, options)
	// Drop the launch frame's plaintext references; never retain ProcessOptions.
	options.Environment = nil
	auth = conversationAuth{}
	spawnError := err
	if executor == nil || executor.RPC == nil || executor.Stopped == nil {
		cancel()
		if executor != nil && executor.RPC != nil {
			executor.RPC.Close()
		}
		// A successful factory owns a complete executor. Incomplete capabilities
		// cannot establish that a child stopped, so retain its private directory.
		if executor == nil {
			directory.remove()
		} else {
			retainedOpening = true
			if executor.Stop != nil {
				_ = executor.Stop()
			}
			if executor.Stopped != nil {
				value.monitors.Add(1)
				go func() {
					defer value.monitors.Done()
					<-executor.Stopped
					if executor.RPC != nil {
						<-executor.RPC.Done()
					}
					directory.remove()
					value.mu.Lock()
					value.conversationOpening = false
					value.mu.Unlock()
				}()
			}
		}
		return nil, ErrDisconnected
	}
	session := &ConversationSession{worker: value, executor: executor, ctx: lifetime, cancel: cancel,
		origin: origin, generation: generation, accountEpoch: accountEpoch,
		conversationID: conversationID, root: root, directory: directory, isCurrent: isCurrent, done: make(chan struct{})}
	value.mu.Lock()
	value.conversationSession = session
	value.monitors.Add(1)
	value.mu.Unlock()
	go session.monitor()
	fail := func(err error) (*ConversationSession, error) {
		_, _ = session.TerminateConfirmed(ctx)
		return nil, err
	}
	if spawnError != nil {
		session.stop()
		return nil, ErrDisconnected
	}
	if err := guard(); err != nil {
		return fail(err)
	}
	info, _ := json.Marshal(map[string]string{"name": "dant", "title": "dant", "version": buildinfo.Version})
	initialized, err := executor.RPC.RequestGuarded(ctx, "initialize", contracts.RawObject{
		"clientInfo": info, "capabilities": json.RawMessage(`{"experimentalApi":true}`),
	}, guard)
	if err != nil {
		return fail(err)
	}
	agent := observerString(initialized, "userAgent")
	if len(agent) > conversationUserAgentBytes || !strings.HasPrefix(agent, conversationUserAgentPrefix) || strings.ContainsFunc(agent, func(character rune) bool { return character < 0x20 || character == 0x7f }) || observerString(initialized, "codexHome") != conversationCodexHome || observerString(initialized, "platformOs") != "linux" || observerString(initialized, "platformFamily") != "unix" {
		return fail(ErrInvalidProtocol)
	}
	if err := guard(); err != nil {
		return fail(err)
	}
	if err := executor.RPC.Notify(ctx, "initialized", nil); err != nil {
		return fail(err)
	}
	if err := guard(); err != nil {
		return fail(err)
	}
	return session, nil
}

func (session *ConversationSession) RuntimeID() string {
	return session.worker.RuntimeID() + ":conversation"
}

// Consumers recheck at application time: a rendezvous can wait while account
// ownership changes after the forwarding goroutine's own validation.
func (session *ConversationSession) ValidateOwner() error {
	return session.current()
}

func (session *ConversationSession) current() error {
	if session.ctx.Err() != nil || !session.worker.current(session.generation, session.conversationID, session.origin) || !session.isCurrent() {
		return ErrConnectionChanged
	}
	session.worker.mu.Lock()
	current := !session.worker.closed && session.worker.accountEpoch == session.accountEpoch && session.worker.conversationSession == session
	session.worker.mu.Unlock()
	if !current {
		return ErrConnectionChanged
	}
	return nil
}

func (session *ConversationSession) RequestGuarded(ctx context.Context, method string, params contracts.RawObject, guard func() error) (contracts.RawObject, error) {
	switch method {
	case "thread/start", "turn/start", "turn/interrupt":
	default:
		return nil, ErrInvalidProtocol
	}
	allowed := []string{"threadId", "turnId"}
	if method == "thread/start" {
		allowed = []string{"model", "developerInstructions", "persistExtendedHistory"}
	} else if method == "turn/start" {
		allowed = []string{"threadId", "input", "model", "effort", "summary"}
	}
	filtered := contracts.RawObject{}
	for _, key := range allowed {
		if raw, exists := params[key]; exists {
			filtered[key] = append(json.RawMessage(nil), raw...)
		}
	}
	params = filtered
	if method == "thread/start" {
		delete(params, "cwd")
		delete(params, "config")
		params["modelProvider"], _ = json.Marshal(conversationProviderID)
		params["environments"] = json.RawMessage("[]")
		params["dynamicTools"] = json.RawMessage("[]")
		params["ephemeral"] = json.RawMessage("true")
		params["sandbox"] = json.RawMessage(`"read-only"`)
		params["approvalPolicy"] = json.RawMessage(`"never"`)
	}
	if method == "turn/start" {
		delete(params, "cwd")
		params["environments"] = json.RawMessage("[]")
		params["sandboxPolicy"] = json.RawMessage(`{"type":"readOnly","networkAccess":false}`)
		params["approvalPolicy"] = json.RawMessage(`"never"`)
	}
	result, err := session.executor.RPC.RequestGuarded(ctx, method, params, func() error {
		if err := session.current(); err != nil {
			return err
		}
		if guard != nil {
			return guard()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := session.current(); err != nil {
		return nil, &OperationError{Cause: err, UnknownOutcome: true}
	}
	return result, nil
}

func (session *ConversationSession) SubscribeEvents() (<-chan Event, func(), error) {
	if err := session.current(); err != nil {
		return nil, nil, err
	}
	session.subscriptionsMu.Lock()
	defer session.subscriptionsMu.Unlock()
	if session.subscriptionsClosed {
		return nil, nil, ErrDisconnected
	}
	events, unsubscribe, err := session.executor.RPC.SubscribeEvents()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(session.ctx)
	var once sync.Once
	stop := func() { once.Do(func() { cancel(); unsubscribe() }) }
	output := make(chan Event)
	session.subscriptions.Add(1)
	go func() {
		defer session.subscriptions.Done()
		defer close(output)
		defer stop()
		for {
			select {
			case <-ctx.Done():
				return
			case event, open := <-events:
				if !open {
					return
				}
				// No Engine callback runs under the RPC subscriber lock.
				if session.current() != nil {
					session.stop()
					return
				}
				select {
				case output <- event:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return output, stop, nil
}

func (session *ConversationSession) ReplyError(ctx context.Context, id RPCID, code int, message string) error {
	return session.executor.RPC.ReplyError(ctx, id, code, message)
}

func (session *ConversationSession) stop() {
	session.once.Do(func() {
		session.cancel()
		session.executor.RPC.Close()
		if session.executor.Stop != nil {
			_ = session.executor.Stop()
		}
	})
}

func (session *ConversationSession) monitor() {
	defer session.worker.monitors.Done()
	select {
	case <-session.ctx.Done():
	case <-session.origin.Done():
	case <-session.executor.Stopped:
	case <-session.executor.RPC.Done():
	}
	session.stop()
	<-session.executor.Stopped
	<-session.executor.RPC.Done()
	session.subscriptionsMu.Lock()
	session.subscriptionsClosed = true
	session.subscriptionsMu.Unlock()
	session.subscriptions.Wait()
	session.directory.remove()
	session.worker.mu.Lock()
	if session.worker.conversationSession == session {
		session.worker.conversationSession = nil
	}
	session.worker.mu.Unlock()
	close(session.done)
}

func (session *ConversationSession) TerminateConfirmed(ctx context.Context) (bool, error) {
	session.stop()
	deadline, cancel := context.WithTimeout(ctx, ExecutorStopTimeout)
	defer cancel()
	select {
	case <-session.done:
		return true, nil
	case <-deadline.Done():
		return false, ErrStopUnconfirmed
	}
}
