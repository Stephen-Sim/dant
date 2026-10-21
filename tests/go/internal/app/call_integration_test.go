package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/voice"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type appVoiceSocket struct {
	input         chan []byte
	done          chan struct{}
	once          sync.Once
	mu            sync.Mutex
	writes        []contracts.RawObject
	reject        bool
	rejectContext bool
	hold          <-chan struct{}
	accepted      chan struct{}
	acceptedOnce  sync.Once
	beforeAck     func()
	written       chan struct{}
	runtimeWire   *appWireFixture
}

func (socket *appVoiceSocket) Read(ctx context.Context) ([]byte, error) {
	select {
	case raw := <-socket.input:
		return raw, nil
	case <-socket.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (socket *appVoiceSocket) Write(ctx context.Context, raw []byte) error {
	var event contracts.RawObject
	if err := json.Unmarshal(raw, &event); err != nil {
		return err
	}
	socket.mu.Lock()
	socket.writes = append(socket.writes, event)
	reject := socket.reject
	rejectContext, hold, accepted, beforeAck, written := socket.rejectContext, socket.hold, socket.accepted, socket.beforeAck, socket.written
	socket.mu.Unlock()
	select {
	case written <- struct{}{}:
	default:
	}
	var kind string
	_ = json.Unmarshal(event["type"], &kind)
	var answer contracts.RawObject
	switch kind {
	case "conversation.item.create":
		if accepted != nil {
			socket.acceptedOnce.Do(func() { close(accepted) })
		}
		if hold != nil {
			select {
			case <-hold:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if beforeAck != nil {
			beforeAck()
		}
		if reject {
			answer = contracts.RawObject{"type": encode("error"), "error": encode(contracts.RawObject{"event_id": event["event_id"], "code": encode("synthetic_rejection")})}
		} else {
			answer = contracts.RawObject{"type": encode("conversation.item.added"), "item": event["item"], "previous_item_id": encode(nil)}
		}
	case "session.update":
		answer = contracts.RawObject{"type": encode("session.updated"), "session": event["session"]}
		if rejectContext {
			answer = contracts.RawObject{"type": encode("error"), "error": encode(contracts.RawObject{"event_id": event["event_id"], "code": encode("synthetic_context_rejection")})}
		}
	}
	if answer != nil {
		select {
		case socket.input <- encode(answer):
		case <-ctx.Done():
			return ctx.Err()
		case <-socket.done:
			return io.EOF
		}
	}
	return nil
}

func (socket *appVoiceSocket) Close() error {
	socket.once.Do(func() { close(socket.done) })
	return nil
}

func (socket *appVoiceSocket) count(kind string) int {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	count := 0
	for _, event := range socket.writes {
		if string(event["type"]) == string(encode(kind)) {
			count++
		}
	}
	return count
}

func activeAPICallFixture(t *testing.T, customize ...func(*WorkerOptions)) (*WorkerApp, *appVoiceSocket, string, *atomic.Int32) {
	t.Helper()
	socket := &appVoiceSocket{input: make(chan []byte, 64), done: make(chan struct{})}
	hangups := &atomic.Int32{}
	app, wire := connectedWorkerFixture(t, func(options *WorkerOptions) {
		options.VoiceHTTP = appHTTPFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Host != "api.openai.com" || request.URL.Scheme != "https" {
				t.Error("voice escaped its fixed fake authority")
			}
			if strings.HasSuffix(request.URL.Path, "/hangup") {
				hangups.Add(1)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			return &http.Response{StatusCode: 201, Header: http.Header{"Location": []string{"https://api.openai.com/v1/realtime/calls/rtc_appfixture"}}, Body: io.NopCloser(strings.NewReader("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"))}, nil
		})
		options.VoiceDial = func(_ context.Context, address, key string) (voice.VoiceSocket, error) {
			if address != "wss://api.openai.com/v1/realtime?call_id=rtc_appfixture" || key != "synthetic-key-not-a-real-account" {
				t.Error("fake voice sideband identity changed")
			}
			return socket, nil
		}
		for _, configure := range customize {
			configure(options)
		}
	})
	socket.runtimeWire = wire
	response := callWorker(app, http.MethodPost, "/api/call", `{"provider":"api","sdp":"v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n","apiKey":"synthetic-key-not-a-real-account"}`)
	requireWorkerStatus(t, response, 200)
	var result voice.CallStartResult
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.CallID == "" {
		t.Fatal("API call start lost its exact identity")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/call/connected", string(encode(contracts.RawObject{"callId": encode(result.CallID)}))), 200)
	return app, socket, result.CallID, hangups
}

func TestWorkerAcceptedCallInputOutlivesCancelledRequestWithoutBeingSubmittedTwice(t *testing.T) {
	app, socket, callID, _ := activeAPICallFixture(t)
	gate := make(chan struct{})
	accepted := make(chan struct{})
	socket.mu.Lock()
	socket.hold, socket.accepted = gate, accepted
	socket.mu.Unlock()
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "accepted lifetime fixture", ClientMessageID: "261c6057-df10-460e-95ba-7932331e10e4"})
	if err != nil {
		t.Fatal(err)
	}
	requestContext, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- app.submitCallMessage(requestContext, app.store.ConversationID(), work.AdmissionReceipt{Message: message, CallID: callID})
	}()
	<-accepted
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal("request cancellation was not returned to its caller")
	}
	changes, stop := app.store.Subscribe()
	defer stop()
	close(gate)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		stored, err := app.store.Message(message.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Submission.Value == contracts.SubmissionStatusConfirmed {
			break
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("accepted call input was abandoned after HTTP cancellation")
		}
	}
	body := `{"text":"accepted lifetime fixture","clientMessageId":"` + message.ClientMessageID + `"}`
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", body), 200)
	if socket.count("conversation.item.create") != 1 {
		t.Fatal("HTTP cancellation caused accepted provider input to replay")
	}
	if err := app.calls.Stop(t.Context(), callID); err != nil {
		t.Fatal("completed input did not join its call lifecycle", err)
	}
	app.Close()
}

func TestWorkerProviderAcceptanceWithFailedDurableAcknowledgementRemainsUnknownAndDeduplicated(t *testing.T) {
	var failWrite atomic.Bool
	app, socket, _, _ := activeAPICallFixture(t, func(options *WorkerOptions) {
		options.StoreOptions.Write = func(ctx context.Context, name string, raw []byte, mode fs.FileMode) error {
			if failWrite.Load() {
				return errors.New("isolated_state_commit_failure")
			}
			return files.WriteAtomic(ctx, name, raw, mode)
		}
	})
	socket.mu.Lock()
	socket.beforeAck = func() { failWrite.Store(true) }
	socket.mu.Unlock()
	body := `{"text":"provider accepted but disk failed","clientMessageId":"0dac7a3a-64ad-4b3e-a88b-d523db805625"}`
	response := callWorker(app, http.MethodPost, "/api/messages", body)
	requireWorkerStatus(t, response, 502)
	if !strings.Contains(response.Body.String(), `"unknownOutcome":true`) {
		t.Fatal("unpersisted provider acknowledgement was reported known-safe")
	}
	state := app.store.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Submission.Value != contracts.SubmissionStatusSubmitting {
		t.Fatal("last durable uncertain submission fence was lost")
	}
	failWrite.Store(false)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", body), 200)
	if socket.count("conversation.item.create") != 1 {
		t.Fatal("durable acknowledgement failure replayed accepted provider action")
	}
}

func TestWorkerMemoryContextFailurePreservesSavedMemoryAndPublishesBoundedNotice(t *testing.T) {
	app, socket, _, _ := activeAPICallFixture(t)
	client, _ := app.events.subscribe(t.Context())
	socket.mu.Lock()
	socket.rejectContext = true
	socket.mu.Unlock()
	if _, err := app.saveNote(t.Context(), "working-memory.md", "durable preference despite rejected live context"); err != nil {
		t.Fatal("live context failure hid an already committed memory write", err)
	}
	if note, err := app.memory.ReadNote(t.Context(), "working-memory.md"); err != nil || note != "durable preference despite rejected live context" {
		t.Fatal("failed call context rolled back authoritative memory")
	}
	select {
	case raw := <-client.control:
		if !strings.Contains(string(raw), "could not confirm its context update") {
			t.Fatal("missing bounded live-context warning")
		}
	default:
		t.Fatal("failed live memory context did not publish a notice")
	}
	if err := app.memory.Close(); err != nil {
		t.Fatal(err)
	}
	if err := app.memoryChanged(t.Context()); err != nil {
		t.Fatal("unavailable context projection fabricated a failed memory commit")
	}
}

func TestWorkerTypedCallMessageIsConfirmedOnceAndKeepsItsMediaOwnership(t *testing.T) {
	app, socket, callID, hangups := activeAPICallFixture(t)
	body := `{"text":"typed call fixture","clientMessageId":"8fcd8506-18f8-44f4-b597-a3295229e14f"}`
	response := callWorker(app, http.MethodPost, "/api/messages", body)
	requireWorkerStatus(t, response, 200)
	var message contracts.ChatMessage
	if json.Unmarshal(response.Body.Bytes(), &message) != nil || message.VoiceCallID != callID || message.Submission.Value != contracts.SubmissionStatusConfirmed || message.UnknownOutcome {
		t.Fatal("call input lost confirmed media submission")
	}
	before := socket.count("conversation.item.create")
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", body), 200)
	if before != 1 || socket.count("conversation.item.create") != before || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("duplicate call input replayed or entered generic task queue")
	}
	owner := work.ToolContext{ConversationID: app.store.ConversationID(), CallID: callID, Owner: callID, IsCurrent: func() bool { return app.calls.Snapshot() != nil }}
	runAcknowledgedTool(t, app, owner, "send_message", `{"text":"explicit media delivery"}`)
	runAcknowledgedTool(t, app, owner, "memory_write", `{"text":"confirmed call preference"}`)
	if socket.count("session.update") == 0 {
		t.Fatal("memory change never reached its active call context")
	}
	app.caption(voice.Caption{CallID: callID, Provider: "api", Sequence: 1, Text: "transient fixture caption", Final: true})
	snapshot, err := app.Snapshot(t.Context())
	if err != nil || !strings.Contains(string(snapshot.Extra["callCaption"]), "transient fixture caption") {
		t.Fatal("live caption did not reach polling snapshot")
	}
	stateBytes, err := os.ReadFile(filepath.Join(app.options.Startup.DataDir, "state.json"))
	if err != nil || strings.Contains(string(stateBytes), "transient fixture caption") {
		t.Fatal("RAM-only caption leaked into durable state")
	}
	if app.callInputCurrent("old-conversation", callID, message.ID) || app.callInputCurrent(app.store.ConversationID(), "old-call", message.ID) || app.callInputCurrent(app.store.ConversationID(), callID, "missing") {
		t.Fatal("call input ownership accepted a stale scope")
	}
	runAcknowledgedTool(t, app, owner, "end_call", `{}`)
	if app.calls.Snapshot() != nil || hangups.Load() != 1 {
		t.Fatal("call lifecycle did not finish once")
	}
	if snapshot, err := app.Snapshot(t.Context()); err != nil || string(snapshot.Extra["callCaption"]) != "null" {
		t.Fatal("ended call retained transient caption")
	}
}

func TestWorkerRejectedCallInputIsKnownNotAcceptedAndNeverRetriedByDuplicate(t *testing.T) {
	app, socket, _, _ := activeAPICallFixture(t)
	socket.mu.Lock()
	socket.reject = true
	socket.mu.Unlock()
	body := `{"text":"rejected fixture input","clientMessageId":"8ed730cc-8824-4b6b-8e74-02b3f983fa86"}`
	response := callWorker(app, http.MethodPost, "/api/messages", body)
	if response.Code < 400 {
		t.Fatal("explicitly rejected call input was reported successful")
	}
	state := app.store.Snapshot()
	if len(state.Messages) == 0 {
		t.Fatal("accepted durable input disappeared on provider rejection")
	}
	message := state.Messages[len(state.Messages)-1]
	if message.Submission.Value != contracts.SubmissionStatusNotSubmitted || message.UnknownOutcome || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
		t.Fatal("explicit provider rejection became an unknown or successful submission")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", body), 200)
	if socket.count("conversation.item.create") != 1 {
		t.Fatal("duplicate client request replayed rejected provider action")
	}
}

func TestWorkerAcceptedCallDeliveryRejectsStaleOrMissingDurableIdentity(t *testing.T) {
	app := fixtureWorker(t)
	if err := app.submitCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{}); err == nil {
		t.Fatal("missing durable message was accepted")
	}
	app.Close()
	if err := app.submitCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{Message: &contracts.ChatMessage{ID: "missing"}}); err != work.ErrClosed {
		t.Fatal("closed Worker admitted call delivery")
	}
}
