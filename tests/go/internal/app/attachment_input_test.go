package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestWorkerAssemblyResolvesHistoricalAttachmentIDsAgainstItsCurrentStore(t *testing.T) {
	options := fixtureWorkerOptions(t)
	options.WorkerOptions.VerifyRuntime = func(context.Context) error { return nil }
	options.WorkerOptions.Command = "isolated-codex"
	turns := make(chan contracts.RawObject, 1)
	options.WorkerOptions.Factory = func(ctx context.Context, _ workerRuntime.ProcessOptions) (*workerRuntime.Executor, error) {
		readInput, input := io.Pipe()
		output, writeOutput := io.Pipe()
		stopped := make(chan struct{})
		rpc, err := workerRuntime.NewRPC(ctx, input, output, nil)
		if err != nil {
			_ = readInput.Close()
			_ = input.Close()
			_ = output.Close()
			_ = writeOutput.Close()
			return nil, err
		}
		go func() {
			defer close(stopped)
			defer readInput.Close()
			defer writeOutput.Close()
			scanner := bufio.NewScanner(readInput)
			for scanner.Scan() {
				var request contracts.RawObject
				if json.Unmarshal(scanner.Bytes(), &request) != nil || request["id"] == nil {
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
					result = json.RawMessage(`{"thread":{"id":"attachment-thread"}}`)
				case "turn/start":
					var params contracts.RawObject
					if json.Unmarshal(request["params"], &params) == nil {
						select {
						case turns <- params:
						case <-ctx.Done():
							return
						}
					}
					result = json.RawMessage(`{"turn":{"id":"attachment-turn"}}`)
				}
				frame, err := json.Marshal(contracts.RawObject{"id": request["id"], "result": result})
				if err != nil {
					return
				}
				if _, err := writeOutput.Write(append(frame, '\n')); err != nil {
					return
				}
			}
		}()
		return &workerRuntime.Executor{RPC: rpc, Stopped: stopped, Stop: func() error { rpc.Close(); return nil }}, nil
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if _, err := app.worker.Connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	file, err := app.attachments.Put(t.Context(), "current.png", "image/png", []byte{137, 80, 78, 71, 13, 10, 26, 10, 1})
	if err != nil {
		t.Fatal(err)
	}
	currentPath := file.GuestPath
	file.GuestPath = filepath.Join(t.TempDir(), "historical-vm", "missing.png")
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Inspect the restored image", Attachments: []contracts.Attachment{file}})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.engine.Enqueue(t.Context(), message); err != nil {
		t.Fatal(err)
	}
	select {
	case params := <-turns:
		var input []struct {
			Type string `json:"type"`
			Path string `json:"path"`
		}
		if json.Unmarshal(params["input"], &input) != nil {
			t.Fatal("Worker executor input was not a valid item list")
		}
		images := 0
		for _, item := range input {
			if item.Type == "localImage" {
				images++
				if item.Path != currentPath {
					t.Error("Worker assembly used a historical attachment path")
				}
			}
		}
		if images != 1 {
			t.Fatal("Worker assembly did not resolve the stable attachment ID through its current store")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Worker attachment input did not reach the isolated executor")
	}
	saved, err := app.store.Message(message.ID)
	if err != nil || saved.ID != message.ID || saved.Text != message.Text || len(saved.Attachments) != 1 || saved.Attachments[0].GuestPath != file.GuestPath {
		t.Fatal("Worker input resolution changed the durable historical attachment")
	}
}
