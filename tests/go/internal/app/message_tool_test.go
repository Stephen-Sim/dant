package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type messageCallFixture struct {
	mu sync.Mutex
	id string
}

func (call *messageCallFixture) Start(context.Context, contracts.RawObject) (contracts.Call, error) {
	return contracts.Call{}, work.ErrBusy
}

func (call *messageCallFixture) Stop(context.Context, string) error { return nil }
func (call *messageCallFixture) Snapshot() *contracts.Call {
	call.mu.Lock()
	defer call.mu.Unlock()
	return &contracts.Call{ID: call.id, Provider: "api", Status: contracts.VoiceCallStatusActive}
}

func (*messageCallFixture) OwnsEvent(workerRuntime.Event) bool                     { return false }
func (*messageCallFixture) HandleEvent(context.Context, workerRuntime.Event) error { return nil }
func (*messageCallFixture) PauseWork(context.Context) error                        { return nil }
func (*messageCallFixture) PendingWork() bool                                      { return false }

func TestAPIMediaMessageDoesNotBorrowAnUnrelatedActiveTaskAndRejectsReplacementCall(t *testing.T) {
	options := fixtureWorkerOptions(t)
	options.WorkerOptions.VerifyRuntime = func(context.Context) error { return nil }
	options.WorkerOptions.Command = "isolated-codex"
	options.WorkerOptions.Factory = func(ctx context.Context, _ workerRuntime.ProcessOptions) (*workerRuntime.Executor, error) {
		readInput, input := io.Pipe()
		output, writeOutput := io.Pipe()
		stopped := make(chan struct{})
		rpc, err := workerRuntime.NewRPC(ctx, input, output, nil)
		if err != nil {
			return nil, err
		}
		go func() {
			defer close(stopped)
			defer readInput.Close()
			defer writeOutput.Close()
			scanner := bufio.NewScanner(readInput)
			for scanner.Scan() {
				var request contracts.RawObject
				if json.Unmarshal(scanner.Bytes(), &request) != nil {
					continue
				}
				if _, present := request["id"]; !present {
					continue
				}
				var method string
				_ = json.Unmarshal(request["method"], &method)
				result := json.RawMessage(`{}`)
				switch method {
				case "account/read":
					result = json.RawMessage(`{"account":null}`)
				case "model/list":
					result = json.RawMessage(`{"data":[]}`)
				case "thread/start":
					result = json.RawMessage(`{"thread":{"id":"fixture-thread"}}`)
				case "turn/start":
					result = json.RawMessage(`{"turn":{"id":"unrelated-turn"}}`)
				}
				frame, _ := json.Marshal(contracts.RawObject{"id": request["id"], "result": result})
				if _, err := writeOutput.Write(append(frame, '\n')); err != nil {
					return
				}
			}
		}()
		return &workerRuntime.Executor{RPC: rpc, Stopped: stopped, Stop: func() error { rpc.Close(); return nil }}, nil
	}
	app, err := NewWorker(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if _, err := app.worker.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := app.engine.Close(); err != nil {
		t.Fatal(err)
	}
	call := &messageCallFixture{id: "captured-media-call"}
	app.engine, err = work.New(app.ctx, app.store, app.worker, work.Options{Calls: call})
	if err != nil {
		t.Fatal(err)
	}
	message, err := app.store.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "independent entrusted task"})
	if err != nil {
		t.Fatal(err)
	}
	if err = app.engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	changes, unsubscribe := app.engine.Subscribe()
	defer unsubscribe()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for app.engine.Snapshot().Active == nil || app.engine.Snapshot().Active.TurnID.Value != "unrelated-turn" {
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("isolated task was not acknowledged")
		}
	}
	owner := work.ToolContext{ConversationID: app.store.ConversationID(), CallID: call.id, Owner: call.id, IsCurrent: func() bool { return true }}
	result, err := app.Execute(context.Background(), "send_message", contracts.RawObject{"text": json.RawMessage(`"media-only delivery"`)}, owner)
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		Sent      bool   `json:"sent"`
		MessageID string `json:"messageId"`
	}
	if json.Unmarshal(result, &receipt) != nil || !receipt.Sent {
		t.Fatal("media-only delivery was not acknowledged")
	}
	saved, err := app.store.Message(receipt.MessageID)
	if err != nil || saved.TaskID.Value != "" || saved.WorkID != "" || app.engine.Snapshot().Active.TurnID.Value != "unrelated-turn" {
		t.Fatal("media-only delivery borrowed task ownership")
	}
	call.mu.Lock()
	call.id = "replacement-call"
	call.mu.Unlock()
	before := len(app.store.Snapshot().Messages)
	if _, err := app.Execute(context.Background(), "send_message", contracts.RawObject{"text": json.RawMessage(`"stale delivery"`)}, owner); err == nil || len(app.store.Snapshot().Messages) != before {
		t.Fatal("old media owner delivered through a replacement call")
	}
}
