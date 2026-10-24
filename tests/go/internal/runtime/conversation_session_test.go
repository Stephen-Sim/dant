package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type conversationFixture struct {
	worker        *LocalWorker
	source        *workerSourceFixture
	origin, child *rpcFixture
	stopped       chan struct{}
	stopOnce      sync.Once
	autoStop      atomic.Bool
	spawns        atomic.Int32
	process       ProcessOptions
}

func sessionFixture(t *testing.T) *conversationFixture {
	t.Helper()
	f := &conversationFixture{origin: newRPCFixture(t), child: newRPCFixture(t), stopped: make(chan struct{})}
	f.autoStop.Store(true)
	f.worker, f.source = workerFixture(t, WorkerOptions{Environment: []string{"DISPLAY=:0", "DANT_CREDENTIAL_BRIDGE_TOKEN=synthetic-private-bridge"}, Factory: func(_ context.Context, options ProcessOptions) (*Executor, error) {
		f.spawns.Add(1)
		f.process = options
		f.process.Environment = append([]string(nil), options.Environment...)
		return &Executor{RPC: f.child.client, Stopped: f.stopped, Stop: func() error {
			if f.autoStop.Load() {
				f.stopOnce.Do(func() { close(f.stopped) })
			}
			return nil
		}}, nil
	}})
	f.worker.options.Command = filepath.Join(f.worker.options.Home, "synthetic-codex")
	if err := os.WriteFile(f.worker.options.Command, []byte("synthetic executable, never run"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.worker.mu.Lock()
	f.worker.status, f.worker.rpc, f.worker.generation = contracts.ConnectionStatusOnline, f.origin.client, 1
	f.worker.models = contracts.RawObject{"data": json.RawMessage(`[{"id":"catalog-id","model":"original-default-model","isDefault":true}]`)}
	f.worker.mu.Unlock()
	t.Cleanup(func() {
		f.stopOnce.Do(func() { close(f.stopped) })
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = f.worker.CloseContext(ctx)
	})
	return f
}

func (f *conversationFixture) opening(t *testing.T, current func() bool) <-chan struct {
	session *ConversationSession
	err     error
} {
	t.Helper()
	done := make(chan struct {
		session *ConversationSession
		err     error
	}, 1)
	go func() {
		session, err := f.worker.OpenConversation(t.Context(), "captured-conversation", current)
		done <- struct {
			session *ConversationSession
			err     error
		}{session, err}
	}()
	answerConversationAuth(t, f.origin, "synthetic-session-bearer")
	return done
}

func (f *conversationFixture) start(t *testing.T) *ConversationSession {
	t.Helper()
	done := f.opening(t, func() bool { return true })
	replyFixture(t, f.child, rpcMethod(t, f.child, "initialize"), `{"userAgent":"dant/0.163.0 (synthetic; test)","codexHome":"/conversation/config","platformOs":"linux","platformFamily":"unix"}`)
	rpcMethod(t, f.child, "initialized")
	result := <-done
	if result.err != nil || result.session == nil {
		t.Fatal("isolated conversation did not start", result.err)
	}
	return result.session
}

func TestConversationSessionLaunchIsScopedPrivateAndItsRequestsCannotEnableTools(t *testing.T) {
	f := sessionFixture(t)
	session := f.start(t)
	if session.RuntimeID() != "vm:isolated:conversation" || f.spawns.Load() != 1 || f.process.Command != "/usr/bin/bwrap" {
		t.Fatal("conversation lost its isolated launch identity")
	}
	if !strings.Contains(strings.Join(f.process.Args, " "), `model="original-default-model"`) {
		t.Fatal("nullable original model lost its captured catalog default")
	}
	environment := strings.Join(f.process.Environment, "\n")
	if !strings.Contains(environment, "DANT_CONVERSATION_ACCESS_TOKEN=synthetic-session-bearer") || strings.Contains(environment, "synthetic-private-bridge") || strings.Contains(environment, "DISPLAY=") {
		t.Fatal("conversation inherited desktop or credential capabilities")
	}
	if err := filepath.WalkDir(session.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(raw), "synthetic-session-bearer") {
			t.Error("conversation persisted authentication")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"account/read", "account/logout", "config/read", "turn/steer", "thread/resume", "thread/realtime/start", "item/tool/call"} {
		if _, err := session.RequestGuarded(t.Context(), method, nil, nil); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("conversation accepted an execution/auth method", method, err)
		}
	}
	for _, method := range []string{"thread/start", "turn/start", "turn/interrupt"} {
		params := contracts.RawObject{"cwd": json.RawMessage(`"private-workspace"`), "config": json.RawMessage(`{"features.shell_tool":true}`), "dynamicTools": json.RawMessage(`[{"name":"unsafe"}]`), "threadId": json.RawMessage(`"thread"`), "turnId": json.RawMessage(`"turn"`), "input": json.RawMessage(`[]`), "approvalPolicy": json.RawMessage(`"always"`), "sandboxPolicy": json.RawMessage(`{"type":"dangerFullAccess"}`), "model": json.RawMessage(`"explicit-user-model"`)}
		before, _ := json.Marshal(params)
		done := make(chan error, 1)
		go func() { _, err := session.RequestGuarded(t.Context(), method, params, nil); done <- err }()
		request := rpcMethod(t, f.child, method)
		var transmitted contracts.RawObject
		if json.Unmarshal(request["params"], &transmitted) != nil {
			t.Fatal("invalid conversation request frame")
		}
		for _, key := range []string{"cwd", "config"} {
			if _, exists := transmitted[key]; exists {
				t.Fatal("caller injected runtime configuration", key)
			}
		}
		if method == "thread/start" && (string(transmitted["ephemeral"]) != "true" || string(transmitted["dynamicTools"]) != "[]" || string(transmitted["sandbox"]) != `"read-only"`) {
			t.Fatal("thread was not ephemeral and tool-less")
		}
		if method == "turn/start" && (!strings.Contains(string(transmitted["sandboxPolicy"]), `"readOnly"`) || string(transmitted["approvalPolicy"]) != `"never"`) {
			t.Fatal("turn escaped its fixed read-only policy")
		}
		if method != "turn/interrupt" && string(transmitted["model"]) != `"explicit-user-model"` {
			t.Fatal("explicit model selection was silently replaced")
		}
		replyFixture(t, f.child, request, `{}`)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		after, _ := json.Marshal(params)
		if string(before) != string(after) {
			t.Fatal("conversation transformed the caller's original arguments")
		}
	}
	root := session.root
	if confirmed, err := session.TerminateConfirmed(t.Context()); err != nil || !confirmed {
		t.Fatal("conversation shutdown was not confirmed", err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("stopped conversation retained its private directory")
	}
}

func TestConversationSessionInitializeRejectsUnverifiedRuntimeBeforeModelDispatch(t *testing.T) {
	for _, response := range []string{`{}`, `{"userAgent":"dant/0.164.0 (future)","codexHome":"/conversation/config","platformOs":"linux","platformFamily":"unix"}`, `{"userAgent":"dant/0.163.0 (synthetic)","codexHome":"/private-home","platformOs":"linux","platformFamily":"unix"}`, `{"userAgent":"dant/0.163.0 (synthetic)","codexHome":"/conversation/config","platformOs":"windows","platformFamily":"unix"}`} {
		f := sessionFixture(t)
		done := f.opening(t, func() bool { return true })
		replyFixture(t, f.child, rpcMethod(t, f.child, "initialize"), response)
		result := <-done
		if !errors.Is(result.err, ErrInvalidProtocol) || result.session != nil {
			t.Fatal("unverified runtime was admitted", result.err)
		}
		if _, err := os.Stat(f.process.Directory); !os.IsNotExist(err) {
			t.Fatal("rejected runtime did not join and clear its temp directory")
		}
	}
}

func TestConversationRoutingOverridesRejectBeforeAuthenticationOrSpawn(t *testing.T) {
	for _, name := range []string{"OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"} {
		t.Run(name, func(t *testing.T) {
			f := sessionFixture(t)
			f.worker.options.Environment = append(f.worker.options.Environment, name+"=synthetic-routing-override")
			if _, err := f.worker.OpenConversation(t.Context(), "captured-conversation", func() bool { return true }); !errors.Is(err, ErrInvalidProtocol) {
				t.Fatal("original routing or billing scope was silently replaced", err)
			}
			if f.spawns.Load() != 0 {
				t.Fatal("routing rejection started a private executor")
			}
			select {
			case <-f.origin.requests:
				t.Fatal("routing rejection requested authentication from the original executor")
			default:
			}
		})
	}
}

func TestConversationSessionLateResponseAndEventsCannotCrossAccountOrConversationScope(t *testing.T) {
	for _, change := range []string{"conversation", "account"} {
		t.Run(change, func(t *testing.T) {
			f := sessionFixture(t)
			session := f.start(t)
			events, unsubscribe, err := session.SubscribeEvents()
			if err != nil {
				t.Fatal(err)
			}
			defer unsubscribe()
			done := make(chan error, 1)
			go func() { _, err := session.RequestGuarded(t.Context(), "turn/start", nil, nil); done <- err }()
			request := rpcMethod(t, f.child, "turn/start")
			if change == "conversation" {
				f.source.setConversation("replacement-conversation")
			} else {
				f.worker.mu.Lock()
				f.worker.accountEpoch++
				f.worker.mu.Unlock()
			}
			replyFixture(t, f.child, request, `{}`)
			var unknown *OperationError
			if err := <-done; !errors.As(err, &unknown) || !unknown.UnknownOutcome {
				t.Fatal("late submitted response became a confirmed or retriable result", err)
			}
			f.child.send(t, `{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","delta":"synthetic stale text"}}`)
			select {
			case _, open := <-events:
				if open {
					t.Fatal("old-account event reached the conversation observer")
				}
			case <-time.After(time.Second):
				t.Fatal("stale subscription did not close")
			}
			if confirmed, err := session.TerminateConfirmed(t.Context()); err != nil || !confirmed {
				t.Fatal("stale conversation did not join", err)
			}
		})
	}
}

func TestConversationSessionConsumerRevalidatesAnEventWaitingBeforeAccountSwitch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := sessionFixture(t)
		session := f.start(t)
		events, unsubscribe, err := session.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		f.child.send(t, `{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","delta":"synthetic old account reply"}}`)
		// No receiver exists yet, so the fully validated forwarder is waiting.
		synctest.Wait()
		f.worker.mu.Lock()
		f.worker.accountEpoch++
		f.worker.mu.Unlock()
		if _, open := <-events; !open {
			t.Fatal("fixture event did not reach its pending rendezvous")
		}
		if err := session.ValidateOwner(); !errors.Is(err, ErrConnectionChanged) {
			t.Fatal("consumer validation accepted an already-waiting old-account event", err)
		}
		if confirmed, err := session.TerminateConfirmed(t.Context()); err != nil || !confirmed {
			t.Fatal("late event subscription was not joined", err)
		}
	})
}

func TestConversationSessionRejectsToolRequestsAndCannotOverlapAnUnconfirmedStop(t *testing.T) {
	f := sessionFixture(t)
	session := f.start(t)
	events, unsubscribe, err := session.SubscribeEvents()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	f.child.send(t, `{"id":"synthetic-tool","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","tool":"send_message"}}`)
	event := <-events
	done := make(chan error, 1)
	go func() {
		done <- session.ReplyError(t.Context(), event.ID.Value, -32601, "Conversation tools are unavailable")
	}()
	reply := <-f.child.requests
	if string(reply["id"]) != `"synthetic-tool"` || len(reply["error"]) == 0 || <-done != nil {
		t.Fatal("conversation did not deny the unexpected tool request")
	}
	f.autoStop.Store(false)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if confirmed, err := session.TerminateConfirmed(ctx); confirmed || !errors.Is(err, ErrStopUnconfirmed) {
		t.Fatal("RPC closure was treated as a stopped child", err)
	}
	if _, err := os.Stat(session.root); err != nil {
		t.Fatal("private directory was removed before process stop proof")
	}
	if _, err := f.worker.OpenConversation(t.Context(), "captured-conversation", func() bool { return true }); err == nil || f.spawns.Load() != 1 {
		t.Fatal("conversation overlapped an unconfirmed executor")
	}
	f.stopOnce.Do(func() { close(f.stopped) })
	if confirmed, err := session.TerminateConfirmed(t.Context()); err != nil || !confirmed {
		t.Fatal("stopped child did not release its reservation", err)
	}
}

func TestConversationOpeningIsJoinedOnCloseAndRetainsIncompleteFactoryOwnership(t *testing.T) {
	t.Run("late factory", func(t *testing.T) {
		f := sessionFixture(t)
		entered, release := make(chan struct{}), make(chan struct{})
		factory := f.worker.options.Factory
		f.worker.options.Factory = func(ctx context.Context, options ProcessOptions) (*Executor, error) {
			close(entered)
			<-release
			return factory(ctx, options)
		}
		done := f.opening(t, func() bool { return true })
		<-entered
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
		defer cancel()
		if err := f.worker.CloseContext(ctx); !errors.Is(err, ErrStopUnconfirmed) {
			t.Fatal("shutdown finished before its in-flight process launch", err)
		}
		close(release)
		if result := <-done; result.err == nil || result.session != nil {
			t.Fatal("late factory made a closed Worker usable")
		}
		if err := f.worker.CloseContext(t.Context()); err != nil {
			t.Fatal("late factory cleanup was not joined", err)
		}
	})
	t.Run("no stop proof", func(t *testing.T) {
		f := sessionFixture(t)
		f.worker.options.Factory = func(_ context.Context, options ProcessOptions) (*Executor, error) {
			f.spawns.Add(1)
			f.process = options
			return &Executor{RPC: f.child.client}, nil
		}
		done := f.opening(t, func() bool { return true })
		result := <-done
		if result.err == nil || result.session != nil {
			t.Fatal("incomplete process capabilities were accepted")
		}
		root := f.process.Directory
		t.Cleanup(func() { _ = os.RemoveAll(root) })
		if _, err := f.worker.OpenConversation(t.Context(), "captured-conversation", func() bool { return true }); err == nil || f.spawns.Load() != 1 {
			t.Fatal("incomplete child permitted a replacement launch")
		}
		if err := f.worker.CloseContext(t.Context()); !errors.Is(err, ErrStopUnconfirmed) {
			t.Fatal("missing stop capability became confirmed shutdown", err)
		}
		if _, err := os.Stat(root); err != nil {
			t.Fatal("unconfirmed child directory was removed")
		}
	})
}
