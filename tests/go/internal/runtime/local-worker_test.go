package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type workerSourceFixture struct {
	mu    sync.Mutex
	state contracts.State
}

func (value *workerSourceFixture) Snapshot() contracts.State {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.state
}

func (value *workerSourceFixture) setConversation(id string) {
	value.mu.Lock()
	value.state.ConversationID = id
	value.mu.Unlock()
}

func workerFixture(t *testing.T, options WorkerOptions) (*LocalWorker, *workerSourceFixture) {
	t.Helper()
	uid := 1000
	options.Platform = "linux"
	options.UID = &uid
	options.Home = t.TempDir()
	options.WorkspaceRoot = filepath.Join(options.Home, "workspaces")
	options.GuestOrigin = "http://127.0.0.1:4320"
	options.RuntimeID = "vm:isolated"
	options.Command = "fixture-codex"
	options.VerifyRuntime = func(context.Context) error { return nil }
	source := &workerSourceFixture{state: contracts.State{ConversationID: "captured-conversation", Messages: []*contracts.ChatMessage{}}}
	worker, err := NewLocalWorker(context.Background(), source, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(worker.Close)
	return worker, source
}

func rpcMethod(t *testing.T, fixture *rpcFixture, expected string) contracts.RawObject {
	t.Helper()
	request, open := <-fixture.requests
	var method string
	if !open || json.Unmarshal(request["method"], &method) != nil || method != expected {
		t.Fatalf("expected bounded fixture method %s", expected)
	}
	return request
}

func replyFixture(t *testing.T, fixture *rpcFixture, request contracts.RawObject, result string) {
	t.Helper()
	encoded, err := json.Marshal(contracts.RawObject{"id": request["id"], "result": json.RawMessage(result)})
	if err != nil {
		t.Fatal(err)
	}
	fixture.send(t, string(encoded))
}

func TestLocalWorkerHandshakeKeepsVMIdentityAndNeverOverlapsUnconfirmedExecutors(t *testing.T) {
	fixture := newRPCFixture(t)
	stopped := make(chan struct{})
	spawned := 0
	var process ProcessOptions
	worker, _ := workerFixture(t, WorkerOptions{Environment: []string{"PATH=/fixture/bin"}, Factory: func(_ context.Context, options ProcessOptions) (*Executor, error) {
		spawned++
		process = options
		return &Executor{RPC: fixture.client, Stopped: stopped, Stop: func() error { return nil }}, nil
	}})
	done := make(chan error, 1)
	go func() { _, err := worker.Connect(context.Background()); done <- err }()
	initialize := rpcMethod(t, fixture, "initialize")
	replyFixture(t, fixture, initialize, `{}`)
	rpcMethod(t, fixture, "initialized")
	replyFixture(t, fixture, rpcMethod(t, fixture, "account/read"), `{"account":null}`)
	replyFixture(t, fixture, rpcMethod(t, fixture, "model/list"), `{"data":[{"id":"fixture-model"}]}`)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if worker.Snapshot().Status != contracts.ConnectionStatusOnline || spawned != 1 || process.Command != "fixture-codex" || !strings.Contains(strings.Join(process.Args, " "), "captured-conversation") {
		t.Fatal("VM handshake lost its exact runtime scope")
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := worker.Connect(cancelled); !errors.Is(err, ErrStopUnconfirmed) {
		t.Fatal("unconfirmed old process was treated as stopped", err)
	}
	if spawned != 1 || worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("a second executor started without positive old-process stop proof")
	}
	close(stopped)
}

func TestConversationChangeDuringHandshakeCannotPublishAnOnlineConnection(t *testing.T) {
	fixture := newRPCFixture(t)
	stopped := make(chan struct{})
	close(stopped)
	worker, source := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
		return &Executor{RPC: fixture.client, Stopped: stopped}, nil
	}})
	done := make(chan error, 1)
	go func() { _, err := worker.Connect(context.Background()); done <- err }()
	initialize := rpcMethod(t, fixture, "initialize")
	source.setConversation("replacement-conversation")
	replyFixture(t, fixture, initialize, `{}`)
	if err := <-done; !errors.Is(err, ErrConnectionChanged) {
		t.Fatal("late handshake adopted replacement conversation", err)
	}
	if worker.Snapshot().Status == contracts.ConnectionStatusOnline {
		t.Fatal("stale handshake made the new scope online")
	}
}

func TestVoiceMessageUsesBoundedWorkerHelperAndRejectsStaleOrEscapingResults(t *testing.T) {
	fixture := newRPCFixture(t)
	calls := 0
	var requested VoiceMessageCommand
	worker, source := workerFixture(t, WorkerOptions{})
	worker.status, worker.rpc = contracts.ConnectionStatusOnline, fixture.client
	output := filepath.Join(worker.WorkspaceRoot(), source.Snapshot().ConversationID, "output")
	worker.options.RunVoiceMessage = func(ctx context.Context, command VoiceMessageCommand) ([]byte, error) {
		calls++
		requested = command
		if _, present := ctx.Deadline(); !present {
			t.Fatal("speech helper has no deadline")
		}
		return json.Marshal(VoiceFile{Path: filepath.Join(command.OutputDirectory, "voice.wav"), Type: "audio/wav"})
	}
	file, err := worker.CreateVoiceMessage(context.Background(), VoiceMessageOptions{Text: "bounded speech", Language: "en", OutputDirectory: output})
	if err != nil || calls != 1 || filepath.Dir(file.Path) != output || !strings.HasSuffix(requested.Script, filepath.Join("vm", "voice_message.py")) {
		t.Fatal("speech helper escaped its fixed Worker capability", err)
	}
	if _, err := worker.CreateVoiceMessage(context.Background(), VoiceMessageOptions{Text: strings.Repeat("x", VoiceMessageTextChars+1), OutputDirectory: output}); err == nil || calls != 1 {
		t.Fatal("oversized speech reached helper")
	}
	if _, err := worker.CreateVoiceMessage(context.Background(), VoiceMessageOptions{Text: "escape", OutputDirectory: filepath.Dir(worker.WorkspaceRoot())}); err == nil || calls != 1 {
		t.Fatal("outside-workspace speech reached helper")
	}
	worker.options.RunVoiceMessage = func(context.Context, VoiceMessageCommand) ([]byte, error) {
		source.setConversation("replacement")
		return json.Marshal(VoiceFile{Path: filepath.Join(output, "voice.wav"), Type: "audio/wav"})
	}
	_, err = worker.CreateVoiceMessage(context.Background(), VoiceMessageOptions{Text: "late speech", OutputDirectory: output})
	var unknown *OperationError
	if !errors.As(err, &unknown) || !unknown.UnknownOutcome {
		t.Fatal("late helper result adopted a new conversation")
	}
}
