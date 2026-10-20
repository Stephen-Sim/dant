package voice

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const fixtureSDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
const fixtureVoiceKey = "fixture-key-not-a-real-account"

func apiEvent(raw string) contracts.RawObject {
	value, _ := contracts.DecodeObject([]byte(raw), maxVoiceEventBytes)
	return value
}

type voiceHTTPFunc func(*http.Request) (*http.Response, error)

func (run voiceHTTPFunc) Do(request *http.Request) (*http.Response, error) { return run(request) }

type fakeVoiceSocket struct {
	mu      sync.Mutex
	input   chan []byte
	done    chan struct{}
	once    sync.Once
	writes  []contracts.RawObject
	respond func(contracts.RawObject)
}

func newVoiceSocket() *fakeVoiceSocket {
	return &fakeVoiceSocket{input: make(chan []byte, 64), done: make(chan struct{})}
}

func (socket *fakeVoiceSocket) Read(ctx context.Context) ([]byte, error) {
	select {
	case value := <-socket.input:
		return value, nil
	case <-socket.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (socket *fakeVoiceSocket) Write(ctx context.Context, data []byte) error {
	value, err := contracts.DecodeObject(data, maxVoiceEventBytes)
	if err != nil {
		return err
	}
	socket.mu.Lock()
	socket.writes = append(socket.writes, value)
	respond := socket.respond
	socket.mu.Unlock()
	if respond != nil {
		respond(value)
	}
	return nil
}

func (socket *fakeVoiceSocket) Close() error {
	socket.once.Do(func() { close(socket.done) })
	return nil
}

func (socket *fakeVoiceSocket) emit(value contracts.RawObject) { socket.input <- rawValue(value) }
func (socket *fakeVoiceSocket) count(kind string) int {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	count := 0
	for _, value := range socket.writes {
		if textField(value, "type") == kind {
			count++
		}
	}
	return count
}

func waitVoice(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("voice fixture condition not reached")
		}
		time.Sleep(time.Millisecond)
	}
}

func apiFixture(t *testing.T, options APIOptions) (*API, *fakeVoiceSocket, *atomic.Int32) {
	t.Helper()
	socket := newVoiceSocket()
	hangups := &atomic.Int32{}
	options.GetKey = func(context.Context) (string, error) { return fixtureVoiceKey, nil }
	if options.RunTask == nil {
		options.RunTask = func(context.Context, string, work.ToolContext) (json.RawMessage, error) {
			return json.RawMessage(`{"success":true}`), nil
		}
	}
	if options.Tool == nil {
		options.Tool = func(context.Context, string, contracts.RawObject, work.ToolContext) (json.RawMessage, error) {
			return json.RawMessage(`{"success":true}`), nil
		}
	}
	options.HTTP = voiceHTTPFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer "+fixtureVoiceKey || request.URL.Scheme != "https" || request.URL.Host != "api.openai.com" {
			t.Error("fixed authenticated transport changed")
		}
		if strings.HasSuffix(request.URL.Path, "/hangup") {
			hangups.Add(1)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
		}
		kind, parameters, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if kind != "multipart/form-data" {
			t.Error("offer was not multipart")
		}
		reader := multipart.NewReader(request.Body, parameters["boundary"])
		parts := map[string]string{}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Error(err)
				break
			}
			data, _ := io.ReadAll(part)
			parts[part.FormName()] = string(data)
		}
		if parts["sdp"] != fixtureSDP || !strings.Contains(parts["session"], "gpt-transcribe") || !strings.Contains(parts["session"], "run_task") {
			t.Error("realtime offer contract changed")
		}
		return &http.Response{StatusCode: 201, Header: http.Header{"Location": []string{voiceAPI + "/rtc_fixture"}}, Body: io.NopCloser(strings.NewReader(fixtureSDP))}, nil
	})
	options.Dial = func(ctx context.Context, address, key string) (VoiceSocket, error) {
		if address != "wss://api.openai.com/v1/realtime?call_id=rtc_fixture" || key != fixtureVoiceKey {
			t.Error("sideband ownership changed")
		}
		return socket, nil
	}
	if options.RequestTimeout == 0 {
		options.RequestTimeout = 100 * time.Millisecond
	}
	options.HangupTimeout = 100 * time.Millisecond
	api, err := NewAPI(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = api.Close(ctx)
	})
	return api, socket, hangups
}

func startAPIFixture(t *testing.T, api *API) {
	t.Helper()
	if _, err := api.Start(context.Background(), APIStart{SDP: fixtureSDP, CallID: "fixture-call"}); err != nil {
		t.Fatal(err)
	}
}

func TestAPIVoiceTypedInputUsesExactReceiptAndCannotReplayUnknown(t *testing.T) {
	api, socket, hangups := apiFixture(t, APIOptions{})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "conversation.item.create" {
			item := objectField(event, "item")
			if textField(item, "type") == "message" {
				socket.emit(object(map[string]any{"type": "conversation.item.added", "item": item}))
			}
		}
	}
	startAPIFixture(t, api)
	message := &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Current request"}
	result, err := api.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: message})
	if err != nil || result.Submission != "confirmed" || result.ConfirmedAt == nil {
		t.Fatal("exact receipt not accepted", err)
	}
	if _, err = api.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: message}); err != nil || socket.count("conversation.item.create") != 1 {
		t.Fatal("same input was submitted again", err)
	}
	changed := *message
	changed.Text = "Changed request"
	if _, err = api.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: &changed}); err == nil {
		t.Fatal("identity reused for changed input")
	}
	if err = api.Stop(context.Background(), "user"); err != nil || hangups.Load() != 1 || api.Snapshot().Call != nil {
		t.Fatal("call shutdown not acknowledged", err)
	}
	unknown, socket, _ := apiFixture(t, APIOptions{RequestTimeout: 20 * time.Millisecond})
	startAPIFixture(t, unknown)
	_, err = unknown.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: message})
	var inputErr *VoiceInputError
	if !errors.As(err, &inputErr) || inputErr.Submission != "unknown" || !inputErr.UnknownOutcome {
		t.Fatal("lost acknowledgement was treated as safe retry", err)
	}
	if _, err = unknown.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: message}); err == nil || socket.count("conversation.item.create") != 1 {
		t.Fatal("unknown input replayed")
	}
	next := *message
	next.ID = "next"
	if _, err = unknown.Message(context.Background(), MessageOptions{CallID: "fixture-call", Message: &next}); err == nil || socket.count("conversation.item.create") != 1 {
		t.Fatal("later input bypassed uncertainty fence")
	}
}

func TestAPIVoiceCompletedToolsDeduplicateAndSpeechCaptionsAreRedacted(t *testing.T) {
	calls := &atomic.Int32{}
	captions := make(chan Caption, 8)
	api, socket, _ := apiFixture(t, APIOptions{RunTask: func(ctx context.Context, text string, owner work.ToolContext) (json.RawMessage, error) {
		if !owner.IsCurrent() || owner.CallID != "fixture-call" || text != "Task request" {
			t.Error("tool scope changed")
		}
		calls.Add(1)
		return json.RawMessage(`{"success":true}`), nil
	}, Subtitle: func(value Caption) { captions <- value }})
	startAPIFixture(t, api)
	tool := object(map[string]any{"type": "function_call", "status": "completed", "name": "run_task", "call_id": "tool-one", "arguments": `{"text":"Task request"}`})
	socket.emit(object(map[string]any{"type": "response.done", "response": map[string]any{"id": "cancelled", "status": "cancelled", "output": []contracts.RawObject{tool}}}))
	time.Sleep(10 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("cancelled response executed a tool")
	}
	for index := 0; index < 2; index++ {
		socket.emit(object(map[string]any{"type": "response.done", "response": map[string]any{"id": "complete", "status": "completed", "output": []contracts.RawObject{tool}}}))
	}
	waitVoice(t, func() bool { return calls.Load() == 1 && socket.count("conversation.item.create") == 1 })
	socket.emit(apiEvent(`{"type":"response.created","response":{"id":"speech"}}`))
	socket.emit(object(map[string]any{"type": "response.output_audio_transcript.delta", "response_id": "speech", "item_id": "spoken", "delta": "Never expose " + fixtureVoiceKey}))
	select {
	case value := <-captions:
		if strings.Contains(value.Text, fixtureVoiceKey) {
			t.Fatal("API key entered captions")
		}
	case <-time.After(time.Second):
		t.Fatal("caption missing")
	}
}

func TestAPILiveMemoryOnlyCommitsMatchingInstructionAcknowledgement(t *testing.T) {
	api, socket, _ := apiFixture(t, APIOptions{ContextTimeout: 500 * time.Millisecond})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "session.update" {
			socket.emit(object(map[string]any{"type": "session.updated", "session": objectField(event, "session")}))
		}
	}
	startAPIFixture(t, api)
	result := api.SyncMemory(context.Background(), "fixture-call", "Durable reference")
	if result.Status != "submitted" {
		t.Fatal("memory update failed", result.Status)
	}
	api.mu.Lock()
	memory := api.session.baseMemory
	api.mu.Unlock()
	if memory != "Durable reference" {
		t.Fatal("acknowledged memory not committed")
	}
	socket.mu.Lock()
	socket.respond = nil
	socket.mu.Unlock()
	result = api.SyncMemory(context.Background(), "fixture-call", "Unconfirmed replacement")
	if result.Status != "unknown" {
		t.Fatal("missing ack coerced to submitted")
	}
	api.mu.Lock()
	memory = api.session.baseMemory
	api.mu.Unlock()
	if memory != "Durable reference" {
		t.Fatal("unacknowledged memory replaced reference")
	}
	before := socket.count("session.update")
	if result = api.SyncMemory(context.Background(), "fixture-call", "Later replacement"); result.Status != "unknown" || socket.count("session.update") != before {
		t.Fatal("uncertain context replayed")
	}
}

func TestAPILateCreateAfterStopIsReclaimedWithoutRevivingSession(t *testing.T) {
	api, _, hangups := apiFixture(t, APIOptions{})
	original := api.options.HTTP
	started, release := make(chan struct{}), make(chan struct{})
	api.options.HTTP = voiceHTTPFunc(func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/hangup") {
			return original.Do(request)
		}
		close(started)
		<-release
		return original.Do(request)
	})
	done := make(chan error, 1)
	go func() {
		_, err := api.Start(context.Background(), APIStart{SDP: fixtureSDP, CallID: "fixture-call"})
		done <- err
	}()
	<-started
	if err := api.Stop(context.Background(), "user"); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, ErrVoiceCancelled) || api.Snapshot().Call != nil || hangups.Load() != 1 {
		t.Fatal("late create leaked or revived", err)
	}
}
