package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestWorkerHandshakeRejectsEachFailedOrStaleResponseAndJoinsItsProcess(t *testing.T) {
	for _, phase := range []string{"initialize error", "account error", "models error", "account changed", "models changed"} {
		t.Run(phase, func(t *testing.T) {
			fixture := newRPCFixture(t)
			stopped := make(chan struct{})
			close(stopped)
			worker, source := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
				return &Executor{RPC: fixture.client, Stopped: stopped}, nil
			}})
			done := make(chan error, 1)
			go func() { _, err := worker.Connect(t.Context()); done <- err }()
			for _, method := range []string{"initialize", "account/read", "model/list"} {
				request := rpcMethod(t, fixture, method)
				failed := phase == "initialize error" && method == "initialize" || phase == "account error" && method == "account/read" || phase == "models error" && method == "model/list"
				changed := phase == "account changed" && method == "account/read" || phase == "models changed" && method == "model/list"
				if failed {
					raw, _ := json.Marshal(contracts.RawObject{"id": request["id"], "error": json.RawMessage(`{"code":-32000,"message":"private isolated failure"}`)})
					fixture.send(t, string(raw))
					break
				}
				if changed {
					source.setConversation("replacement-conversation")
				}
				replyFixture(t, fixture, request, `{}`)
				if changed {
					break
				}
				if method == "initialize" {
					rpcMethod(t, fixture, "initialized")
				}
			}
			if err := <-done; err == nil || worker.Snapshot().Status != contracts.ConnectionStatusOffline || worker.Snapshot().Error.Value != "executor_connection_failed" {
				t.Fatal("failed handshake published an online connection", phase, err)
			}
			if err := worker.CloseContext(t.Context()); err != nil {
				t.Fatal("failed handshake did not join its owned process", err)
			}
		})
	}
}

func TestWorkerConnectionRejectsInvalidRolesDirectoriesExecutorsAndChangedGenerations(t *testing.T) {
	for _, kind := range []string{"platform", "root user", "missing conversation", "workspace file", "nil executor", "missing RPC", "missing stop proof", "closed RPC", "changed generation", "verify changed"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newRPCFixture(t)
			stopped := make(chan struct{})
			close(stopped)
			worker, source := workerFixture(t, WorkerOptions{})
			worker.options.Factory = func(context.Context, ProcessOptions) (*Executor, error) {
				switch kind {
				case "nil executor":
					return nil, nil
				case "missing RPC":
					return &Executor{Stopped: stopped}, nil
				case "missing stop proof":
					return &Executor{RPC: fixture.client}, nil
				case "changed generation":
					worker.mu.Lock()
					worker.generation++
					worker.mu.Unlock()
				}
				return &Executor{RPC: fixture.client, Stopped: stopped}, nil
			}
			switch kind {
			case "platform":
				worker.options.Platform = "windows"
			case "root user":
				zero := 0
				worker.options.UID = &zero
			case "missing conversation":
				source.setConversation("")
			case "workspace file":
				if err := os.WriteFile(worker.options.WorkspaceRoot, []byte("ordinary file"), 0600); err != nil {
					t.Fatal(err)
				}
			case "closed RPC":
				fixture.client.Close()
				<-fixture.client.Done()
			case "verify changed":
				worker.options.VerifyRuntime = func(context.Context) error { source.setConversation("replacement"); return nil }
			}
			if _, err := worker.Connect(t.Context()); err == nil || worker.Snapshot().Status == contracts.ConnectionStatusOnline {
				t.Fatal("unverified executor became usable", kind, err)
			}
		})
	}
}

func TestWorkerUsesAnExistingConfiguredHomeExecutableWithoutSpawningIt(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	file := filepath.Join(worker.options.Home, ".local", "bin", "codex")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	worker.options.Command = ""
	cause := errors.New("isolated factory failure")
	worker.options.Factory = func(_ context.Context, options ProcessOptions) (*Executor, error) {
		if options.Command != file {
			t.Fatal("discovery did not retain its configured home", options.Command)
		}
		return nil, cause
	}
	if _, err := worker.Connect(t.Context()); !errors.Is(err, cause) {
		t.Fatal("factory failure did not prevent a connection", err)
	}
}

func TestConcurrentConnectionWaitersShareTheSameConfirmedFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		worker, _ := workerFixture(t, WorkerOptions{})
		gate := make(chan struct{})
		verifications := 0
		worker.options.VerifyRuntime = func(context.Context) error { verifications++; <-gate; return ErrVMUnavailable }
		first, second := make(chan error, 1), make(chan error, 1)
		go func() { _, err := worker.Connect(t.Context()); first <- err }()
		synctest.Wait()
		go func() { _, err := worker.Connect(t.Context()); second <- err }()
		synctest.Wait()
		close(gate)
		if !errors.Is(<-first, ErrVMUnavailable) || !errors.Is(<-second, ErrVMUnavailable) || verifications != 1 {
			t.Fatal("joined connection started another executor attempt")
		}
	})
}

func TestWorkerReconnectRequiresThePreviousExecutorToHaveStopped(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	old := newRPCFixture(t)
	stopped, stopCalls := make(chan struct{}), 0
	close(stopped)
	worker.rpc = old.client
	worker.executor = &Executor{RPC: old.client, Stopped: stopped, Stop: func() error { stopCalls++; return nil }}
	worker.options.Factory = func(context.Context, ProcessOptions) (*Executor, error) { return nil, ErrDisconnected }
	if _, err := worker.Connect(t.Context()); !errors.Is(err, ErrDisconnected) || stopCalls != 1 {
		t.Fatal("reconnect did not retire the confirmed old process", err)
	}
}

func TestOnlineWorkerForwardsRepliesEventsAndLogoutAndKeepsStaleOutcomesUnknown(t *testing.T) {
	fixture := newRPCFixture(t)
	worker, source := workerFixture(t, WorkerOptions{SkillContext: func() string { return "Scoped skill reference" }})
	worker.rpc, worker.status = fixture.client, contracts.ConnectionStatusOnline
	events, unsubscribe, err := worker.SubscribeEvents()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	fixture.send(t, `{"method":"fixture/event","params":{}}`)
	if event := <-events; event.Method != "fixture/event" {
		t.Fatal("online event subscription lost its provider method")
	}
	for _, isError := range []bool{false, true} {
		done := make(chan error, 1)
		go func() {
			if isError {
				done <- worker.ReplyError(t.Context(), NumericRPCID(9), -32000, "bounded fixture error")
			} else {
				done <- worker.Reply(t.Context(), NumericRPCID(9), []byte(`{}`))
			}
		}()
		request := <-fixture.requests
		if string(request["id"]) != "9" || <-done != nil {
			t.Fatal("worker reply did not preserve exact provider identity")
		}
	}
	for _, method := range []string{"turn/start", "account/logout", "thread/read"} {
		done := make(chan rpcResult, 1)
		go func() {
			result, err := worker.Request(t.Context(), method, contracts.RawObject{"input": []byte(`[]`)})
			done <- rpcResult{object: result, err: err}
		}()
		request := rpcMethod(t, fixture, method)
		if method == "thread/read" {
			source.setConversation("replacement")
		}
		replyFixture(t, fixture, request, `{}`)
		result := <-done
		if method == "thread/read" {
			var unknown *OperationError
			if !errors.As(result.err, &unknown) || !unknown.UnconfirmedOutcome() || !errors.Is(result.err, ErrConnectionChanged) {
				t.Fatal("late request result confirmed the replacement conversation", result.err)
			}
		} else if result.err != nil {
			t.Fatal("owned worker request failed", result.err)
		}
		if method == "account/logout" && string(worker.Snapshot().Account["account"]) != "null" {
			t.Fatal("confirmed logout left a stale account snapshot")
		}
	}
}
