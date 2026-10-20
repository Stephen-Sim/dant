package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type appWireFixture struct {
	mu       sync.Mutex
	writer   *io.PipeWriter
	methods  []string
	response func(string, contracts.RawObject) json.RawMessage
}

func (wire *appWireFixture) frame(value contracts.RawObject) error {
	wire.mu.Lock()
	defer wire.mu.Unlock()
	_, err := wire.writer.Write(append(encode(value), '\n'))
	return err
}

func (wire *appWireFixture) count(method string) int {
	wire.mu.Lock()
	defer wire.mu.Unlock()
	count := 0
	for _, value := range wire.methods {
		if value == method {
			count++
		}
	}
	return count
}

func connectedWorkerFixture(t *testing.T, customize func(*WorkerOptions)) (*WorkerApp, *appWireFixture) {
	t.Helper()
	wire := &appWireFixture{}
	options := fixtureWorkerOptions(t)
	options.WorkerOptions.VerifyRuntime = func(context.Context) error { return nil }
	options.WorkerOptions.Command = "isolated-codex"
	options.WorkerOptions.Factory = func(ctx context.Context, _ workerRuntime.ProcessOptions) (*workerRuntime.Executor, error) {
		readInput, input := io.Pipe()
		output, writeOutput := io.Pipe()
		stopped := make(chan struct{})
		rpc, err := workerRuntime.NewRPC(ctx, input, output, nil)
		if err != nil {
			t.Fatal(err)
		}
		wire.mu.Lock()
		wire.writer = writeOutput
		wire.mu.Unlock()
		go func() {
			defer close(stopped)
			defer readInput.Close()
			defer writeOutput.Close()
			scanner := bufio.NewScanner(readInput)
			for scanner.Scan() {
				var request contracts.RawObject
				if json.Unmarshal(scanner.Bytes(), &request) != nil {
					return
				}
				var method string
				_ = json.Unmarshal(request["method"], &method)
				wire.mu.Lock()
				wire.methods = append(wire.methods, method)
				wire.mu.Unlock()
				if request["id"] == nil {
					continue
				}
				var params contracts.RawObject
				_ = json.Unmarshal(request["params"], &params)
				result := json.RawMessage(`{}`)
				switch method {
				case "account/read":
					result = json.RawMessage(`{"account":{"type":"fixture"}}`)
				case "model/list", "skills/list":
					result = json.RawMessage(`{"data":[]}`)
				case "thread/start", "thread/resume":
					result = json.RawMessage(`{"thread":{"id":"app-fixture-thread"}}`)
				case "turn/start":
					result = json.RawMessage(`{"turn":{"id":"app-fixture-turn"}}`)
				}
				if wire.response != nil {
					if replacement := wire.response(method, params); replacement != nil {
						result = replacement
					}
				}
				if wire.frame(contracts.RawObject{"id": request["id"], "result": result}) != nil {
					return
				}
				if method == "turn/interrupt" {
					if wire.frame(contracts.RawObject{"method": encode("turn/completed"), "params": encode(contracts.RawObject{
						"threadId": params["threadId"], "turn": encode(contracts.RawObject{"id": params["turnId"], "status": encode(contracts.RuntimeTerminalTurnStatusInterrupted)}),
					})}) != nil {
						return
					}
				}
			}
		}()
		return &workerRuntime.Executor{RPC: rpc, Stopped: stopped, Stop: func() error { rpc.Close(); return nil }}, nil
	}
	if customize != nil {
		customize(&options)
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if _, err := app.worker.Connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	return app, wire
}

func acknowledgedToolFixture(t *testing.T) (*WorkerApp, *appWireFixture, work.ToolContext) {
	t.Helper()
	app, wire := connectedWorkerFixture(t, nil)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "explicitly entrusted isolated task"})
	if err != nil {
		t.Fatal(err)
	}
	changes, unsubscribe := app.engine.Subscribe()
	defer unsubscribe()
	if err := app.engine.Enqueue(t.Context(), message); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		if owner, current := app.engine.ToolScope(); current {
			if owner.TurnID != "app-fixture-turn" || owner.ConversationID != app.store.ConversationID() {
				t.Fatal("executor acknowledgement lost scope")
			}
			return app, wire, owner
		}
		select {
		case <-changes:
		case <-deadline.Done():
			t.Fatal("isolated task was not acknowledged")
		}
	}
}

func runAcknowledgedTool(t *testing.T, app *WorkerApp, owner work.ToolContext, name, body string) json.RawMessage {
	t.Helper()
	var args contracts.RawObject
	if json.Unmarshal([]byte(body), &args) != nil {
		t.Fatal("invalid synthetic tool input")
	}
	result, err := app.Execute(t.Context(), name, args, owner)
	if err != nil {
		t.Fatalf("tool %s: %v", name, err)
	}
	return result
}

func TestWorkerAcknowledgedCredentialAndMemoryToolsPreserveOwnerAndRedactPublicState(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	secret := "synthetic-credential-not-a-real-token"
	raw := runAcknowledgedTool(t, app, owner, "credential_store", `{"name":"fixture","service":"example.invalid","username":"synthetic","secret":"`+secret+`"}`)
	var credential security.CredentialMetadata
	if json.Unmarshal(raw, &credential) != nil || credential.ID == "" || strings.Contains(string(raw), secret) {
		t.Fatal("credential metadata leaked a secret or lost its ID")
	}
	found := runAcknowledgedTool(t, app, owner, "credential_find", `{"query":"fixture"}`)
	if !strings.Contains(string(found), credential.ID) || strings.Contains(string(found), secret) {
		t.Fatal("credential search lost metadata isolation")
	}
	value := runAcknowledgedTool(t, app, owner, "credential_get", `{"id":"`+credential.ID+`"}`)
	if !strings.Contains(string(value), secret) {
		t.Fatal("acknowledged credential retrieval did not return its exact synthetic value")
	}
	runAcknowledgedTool(t, app, owner, "memory_write", `{"text":"confirmed fixture preference"}`)
	runAcknowledgedTool(t, app, owner, "send_message", `{"text":"delivery with `+secret+`"}`)
	snapshot, err := app.Snapshot(t.Context())
	if err != nil || strings.Contains(string(encode(snapshot)), secret) || !strings.Contains(string(encode(snapshot)), "confirmed fixture preference") {
		t.Fatal("public state leaked a credential or lost the memory commit")
	}
	if wire.count("turn/start") != 1 {
		t.Fatal("tools started another execution turn")
	}
}

func TestWorkerAcknowledgedSkillsSchedulesAndReactionsCommitThroughExistingOwner(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	skill := runAcknowledgedTool(t, app, owner, "skill_save", `{"name":"fixture-skill","description":"Isolated fixture","instructions":"Only describe the fixture. Do not execute helpers."}`)
	if !strings.Contains(string(skill), `"saved":true`) || !strings.Contains(string(skill), `"helpersTested":false`) {
		t.Fatal("skill write invented helper execution or lost committed receipt")
	}
	if !strings.Contains(string(runAcknowledgedTool(t, app, owner, "skill_list", `{}`)), "fixture-skill") {
		t.Fatal("saved skill is not listed")
	}
	if !strings.Contains(string(runAcknowledgedTool(t, app, owner, "skill_get", `{"name":"fixture-skill"}`)), "Only describe") {
		t.Fatal("saved skill was not retrieved")
	}
	at := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	scheduled := runAcknowledgedTool(t, app, owner, "schedule_save", `{"text":"future fixture","at":"`+at+`","timeZone":"UTC"}`)
	var receipt struct {
		Saved bool `json:"saved"`
		Item  struct {
			ID string `json:"id"`
		} `json:"item"`
	}
	if json.Unmarshal(scheduled, &receipt) != nil || !receipt.Saved || receipt.Item.ID == "" {
		t.Fatal("schedule tool lost committed identity")
	}
	if !strings.Contains(string(runAcknowledgedTool(t, app, owner, "schedule_list", `{}`)), receipt.Item.ID) {
		t.Fatal("schedule not listed")
	}
	runAcknowledgedTool(t, app, owner, "schedule_delete", `{"id":"`+receipt.Item.ID+`"}`)
	runAcknowledgedTool(t, app, owner, "react_message", `{"messageId":"`+owner.MessageID+`","emoji":"👍"}`)
	message, err := app.store.Message(owner.MessageID)
	if err != nil || !strings.Contains(string(encode(message)), "👍") {
		t.Fatal("reaction was not attached to its original user message")
	}
	if wire.count("turn/start") != 1 {
		t.Fatal("metadata tools admitted a second task")
	}
}

func TestWorkerToolValidationAndStaleOwnerNeverProduceSideEffects(t *testing.T) {
	app, _, owner := acknowledgedToolFixture(t)
	for _, test := range []struct{ name, body string }{
		{"unknown", `{}`}, {"memory_write", `{"text":"fixture","unexpected":true}`},
		{"memory_write", `{"file":false,"text":"fixture"}`}, {"memory_write", `{"text":" "}`},
		{"send_message", `{"text":false}`}, {"send_message", `{"text":"` + strings.Repeat("x", maxToolText+1) + `"}`},
		{"credential_find", `{"query":false}`}, {"credential_get", `{"id":false}`},
		{"credential_store", `{"id":false}`}, {"credential_request", `{"name":"fixture","extra":true}`},
		{"credential_request", `{"name":false}`}, {"skill_get", `{"name":false}`}, {"skill_save", `{"name":false}`},
		{"schedule_list", `{"unexpected":true}`}, {"schedule_delete", `{"id":"fixture","extra":true}`},
		{"schedule_delete", `{"id":false}`}, {"schedule_save", `{"text":false}`},
		{"react_message", `{"messageId":"fixture","emoji":"👍","extra":true}`},
		{"react_message", `{"messageId":false,"emoji":"👍"}`},
		{"react_message", `{"messageId":"missing","emoji":false}`},
		{"react_message", `{"messageId":"missing","emoji":"👍"}`},
		{"send_file", `{"path":false}`}, {"create_voice_message", `{"text":false}`},
		{"create_voice_message", `{"text":"fixture","voice":false}`},
	} {
		t.Run(test.name+"/"+test.body[:min(len(test.body), 40)], func(t *testing.T) {
			before := app.store.Revision()
			var args contracts.RawObject
			_ = json.Unmarshal([]byte(test.body), &args)
			if _, err := app.Execute(t.Context(), test.name, args, owner); err == nil {
				t.Fatal("malformed task tool was accepted")
			}
			if app.store.Revision() != before {
				t.Fatal("rejected tool changed durable messages")
			}
		})
	}
	stale := owner
	stale.IsCurrent = func() bool { return false }
	if _, err := app.Execute(t.Context(), "send_message", contracts.RawObject{"text": encode("must never be delivered")}, stale); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("retired tool owner delivered a message")
	}
	withoutTurn := owner
	withoutTurn.TurnID = ""
	if _, err := app.fileTool(t.Context(), "send_file", contracts.RawObject{"path": encode("fixture")}, withoutTurn); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("call-only owner inherited file execution authority")
	}
}

func TestWorkerMessageToolUsesSharedUTF16DeliveryLimit(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	before := app.store.Revision()
	tooLong := strings.Repeat("😀", work.MaxDeliveredTextUnits/2+1)
	if _, err := app.Execute(t.Context(), "send_message", contracts.RawObject{"text": encode(tooLong)}, owner); err == nil {
		t.Fatal("tool accepted text beyond the shared UTF-16 delivery limit")
	}
	if app.store.Revision() != before {
		t.Fatal("over-limit text changed durable messages")
	}

	text := strings.Repeat("😀", work.MaxDeliveredTextUnits/2)
	runAcknowledgedTool(t, app, owner, "send_message", string(encode(map[string]string{"text": text})))
	state := app.store.Snapshot()
	if len(state.Messages) == 0 || state.Messages[len(state.Messages)-1].Text != text {
		t.Fatal("exact-limit Unicode text was not delivered intact")
	}
	if wire.count("turn/start") != 1 {
		t.Fatal("explicit delivery admitted a second execution")
	}
}

func TestWorkerExplicitFileToolArchivesOnlyOwnedOutputWithoutNewTask(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	output := filepath.Join(app.options.Startup.WorkspaceRoot, owner.ConversationID, "output")
	if err := os.MkdirAll(output, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(output, "fixture.bin")
	data := []byte{0, 255, 17, 4}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}
	raw := runAcknowledgedTool(t, app, owner, "send_file", string(encode(contracts.RawObject{"path": encode(file)})))
	if !strings.Contains(string(raw), `"sent":true`) {
		t.Fatal("owned output did not receive a delivery receipt")
	}
	state := app.store.Snapshot()
	if len(state.Messages) != 2 || len(state.Messages[1].Attachments) != 1 || state.Messages[1].TaskID.Value != owner.MessageID || wire.count("turn/start") != 1 {
		t.Fatal("file delivery lost task ownership or admitted new execution")
	}
	fileID := state.Messages[1].Attachments[0].ID
	response := callWorker(app, http.MethodGet, "/api/files/"+fileID, "")
	if response.Code != 200 || string(response.Body.Bytes()) != string(data) {
		t.Fatal("archived file did not preserve original bytes")
	}
}

func TestWorkerCredentialBridgeRequiresBothItsExactTokenAndCurrentAcknowledgedTask(t *testing.T) {
	app, wire, _ := acknowledgedToolFixture(t)
	request := func(body string) *httptest.ResponseRecorder {
		input := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317/api/internal/credentials", strings.NewReader(body))
		input.Header.Set("X-Dant-Credential-Token", app.credentialToken)
		input.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, input)
		return response
	}
	for _, body := range []string{`{`, `{"tool":false}`, `{"tool":"not_allowed","arguments":{}}`, `{"tool":"skill_list","arguments":null}`} {
		requireWorkerStatus(t, request(body), 400)
	}
	requireWorkerStatus(t, request(`{"tool":"skill_list","arguments":{}}`), 200)
	response := httptest.NewRecorder()
	err := app.credentialBridge(response, httptest.NewRequest(http.MethodPost, "/api/internal/credentials", nil))
	var denied *contracts.APIError
	if !errors.As(err, &denied) || denied.Code != "bridge_forbidden" {
		t.Fatal("direct bridge call bypassed token check")
	}
	if wire.count("turn/start") != 1 {
		t.Fatal("credential bridge granted additional execution")
	}
	app.engine.Close()
	requireWorkerStatus(t, request(`{"tool":"skill_list","arguments":{}}`), 409)
}

func TestWorkerCredentialRequestCancellationIsJoinedAndDoesNotStoreOrReplaySecrets(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	completed := make(chan error, 1)
	go func() {
		_, err := app.Execute(ctx, "credential_request", contracts.RawObject{
			"name": encode("fixture permission"), "service": encode("example.invalid"), "reason": encode("isolated test"),
		}, owner)
		completed <- err
	}()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for len(app.credentials.Snapshot(t.Context()).Requests) == 0 {
		select {
		case <-app.wake:
		case <-deadline.C:
			t.Fatal("credential form was not published")
		}
	}
	cancel()
	select {
	case err := <-completed:
		if err == nil {
			t.Fatal("cancelled credential wait reported a stored credential")
		}
	case <-deadline.C:
		t.Fatal("credential wait did not join")
	}
	if state := app.credentials.Snapshot(t.Context()); len(state.Items) != 0 || len(state.Requests) != 0 {
		t.Fatal("cancelled credential request retained a form or credential")
	}
	if wire.count("turn/start") != 1 {
		t.Fatal("credential cancellation replayed work")
	}
}
