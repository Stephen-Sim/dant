package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const fixtureToken = "123456:fixture_token_is_not_a_real_secret"

type httpFunc func(*http.Request) (*http.Response, error)

func (run httpFunc) Do(request *http.Request) (*http.Response, error) { return run(request) }
func reply(status int, text string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(text))}
}

type gatewayFixture struct {
	Gateway   *Gateway
	Store     *store.Store
	Directory string
	Now       atomic.Int64
	Admitted  atomic.Int32
	Sent      atomic.Int32
	mu        sync.Mutex
	Bodies    []contracts.RawObject
	Send      func(*http.Request) (*http.Response, error)
	Admit     func(context.Context, string, *contracts.ChatMessage) error
}

func fixture(t *testing.T) *gatewayFixture {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	persistence, err := store.Open(filepath.Join(directory, "state"), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = persistence.Mutate(ctx, func(state *contracts.State) error { state.Settings.Language = "en"; return nil }); err != nil {
		t.Fatal(err)
	}
	attachments, err := files.OpenAttachmentStore(filepath.Join(directory, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	result := &gatewayFixture{Store: persistence, Directory: directory}
	result.Now.Store(20000)
	options := Options{Store: persistence, Attachments: attachments, Now: func() time.Time { return time.UnixMilli(result.Now.Load()) }, MirrorGrace: time.Millisecond, Admit: func(ctx context.Context, conversation string, message *contracts.ChatMessage) error {
		result.Admitted.Add(1)
		if result.Admit != nil {
			return result.Admit(ctx, conversation, message)
		}
		return nil
	}, WorkSnapshot: func() WorkState { return WorkState{Online: true} }, HTTP: httpFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Scheme != "https" || request.URL.Host != "api.telegram.org" {
			t.Error("transport left fixed origin")
		}
		if strings.HasSuffix(request.URL.Path, "/getMe") {
			return reply(200, `{"ok":true,"result":{"id":11,"is_bot":true,"username":"fixture_bot"}}`), nil
		}
		if strings.HasSuffix(request.URL.Path, "/getWebhookInfo") {
			return reply(200, `{"ok":true,"result":{"url":""}}`), nil
		}
		result.Sent.Add(1)
		if request.Header.Get("Content-Type") == "application/json" {
			data, _ := io.ReadAll(request.Body)
			body, _ := contracts.DecodeObject(data, MaxResponseBytes)
			result.mu.Lock()
			result.Bodies = append(result.Bodies, body)
			result.mu.Unlock()
		}
		if result.Send != nil {
			return result.Send(request)
		}
		return reply(200, `{"ok":true,"result":{"message_id":42}}`), nil
	})}
	gateway, err := Open(ctx, directory, options)
	if err != nil {
		t.Fatal(err)
	}
	result.Gateway = gateway
	gateway.mu.Lock()
	gateway.config.Token = pointer(fixtureToken)
	gateway.config.Bot = &Bot{"11", "fixture_bot"}
	gateway.config.Enabled = true
	gateway.config.Owner = &Owner{ChatID: "21", UserID: "31", PairingID: "fixture-pairing", SyncVersion: 1, ConversationID: persistence.Snapshot().ConversationID}
	err = gateway.saveLocked(ctx)
	gateway.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		_ = gateway.Close(bounded)
		persistence.Close()
	})
	return result
}

func (fixture *gatewayFixture) add(t *testing.T, role contracts.Role, text string) *contracts.ChatMessage {
	t.Helper()
	message, err := fixture.Store.Add(context.Background(), &contracts.ChatMessage{Role: role, Text: text, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))})
	if err != nil {
		t.Fatal(err)
	}
	return message
}
func (fixture *gatewayFixture) flush(t *testing.T) {
	t.Helper()
	if _, err := fixture.Gateway.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestUnreadMirrorVisibilityGraceCombinesAndSuppressesOnlyObservedFiles(t *testing.T) {
	fixture := fixture(t)
	first := fixture.add(t, contracts.RoleAssistant, "first")
	fixture.add(t, contracts.RoleAssistant, "second")
	fixture.flush(t)
	if fixture.Sent.Load() != 0 {
		t.Fatal("visibility grace was bypassed")
	}
	if _, err := fixture.Store.Update(context.Background(), first.ID, contracts.MessagePatch{"read": raw(true)}); err != nil {
		t.Fatal(err)
	}
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 1 || len(fixture.Bodies) != 1 || field(fixture.Bodies[0], "text") != "second" {
		t.Fatal("already-read content was forwarded")
	}
	fixture.add(t, contracts.RoleAssistant, "third")
	fixture.add(t, contracts.RoleAssistant, "fourth")
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 2 || field(fixture.Bodies[1], "text") != "third\n\nfourth" || string(fixture.Bodies[1]["disable_notification"]) != "true" {
		t.Fatal("consecutive assistant replies did not combine quietly")
	}
}

func TestUnknownDeliverySurvivesRestartAndDoesNotSendRemainingParts(t *testing.T) {
	fixture := fixture(t)
	fixture.Send = func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private transport cause " + fixtureToken)
	}
	fixture.add(t, contracts.RoleAssistant, strings.Repeat("x", 5000))
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	fixture.flush(t)
	if fixture.Sent.Load() != 1 {
		t.Fatal("uncertain delivery was repeated")
	}
	data, err := files.ReadRegular(filepath.Join(fixture.Directory, "telegram.json"), MaxConfigBytes)
	if err != nil {
		t.Fatal(err)
	}
	config, _, err := restoreConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Outbox) != 2 || config.Outbox[0].Status != OutboxUnknown || config.Outbox[1].Status != OutboxFailed {
		t.Fatal("remaining uncertain reply parts were not fenced")
	}
	public, _ := json.Marshal(fixture.Gateway.Status())
	if strings.Contains(string(public), fixtureToken) || strings.Contains(string(public), "private transport") {
		t.Fatal("public status leaked transport details")
	}
}

func TestRateLimitRetryRechecksReadStateAndDoesNotResendReadMessage(t *testing.T) {
	fixture := fixture(t)
	message := fixture.add(t, contracts.RoleAssistant, "read while waiting")
	fixture.Send = func(*http.Request) (*http.Response, error) {
		if _, err := fixture.Store.Update(context.Background(), message.ID, contracts.MessagePatch{"read": raw(true)}); err != nil {
			t.Fatal(err)
		}
		return reply(429, `{"ok":false,"error_code":429,"parameters":{"retry_after":0.001}}`), nil
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 1 {
		t.Fatal("safe retry ignored the newer desktop read receipt")
	}
	fixture.Gateway.mu.Lock()
	defer fixture.Gateway.mu.Unlock()
	if fixture.Gateway.config.Outbox[0].Status != OutboxSuppressed {
		t.Fatal("read message remained queued")
	}
}

func TestIncomingDurableReceiptPrecedesAdmissionAndNeverReplays(t *testing.T) {
	fixture := fixture(t)
	fixture.Admit = func(ctx context.Context, conversation string, message *contracts.ChatMessage) error {
		data, err := files.ReadRegular(filepath.Join(fixture.Directory, "telegram.json"), MaxConfigBytes)
		if err != nil {
			t.Fatal(err)
		}
		config, _, err := restoreConfig(data)
		if err != nil || len(config.Receipts) != 1 || config.Receipts[0].Status != ReceiptUnknown {
			t.Fatal("no durable processing fence before admission")
		}
		if conversation != fixture.Store.Snapshot().ConversationID || field(message.Source, "pairingId") != "fixture-pairing" {
			t.Fatal("admission identity changed")
		}
		return fixture.Store.Mutate(ctx, func(state *contracts.State) error {
			messageByID(*state, message.ID).Submission = contracts.Some(contracts.SubmissionStatusUnknown)
			return nil
		})
	}
	update, err := ReadUpdate([]byte(`{"update_id":7,"message":{"message_id":17,"text":"request","chat":{"id":21,"type":"private"},"from":{"id":31}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = fixture.Gateway.Receive(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	if err = fixture.Gateway.Receive(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	if fixture.Admitted.Load() != 1 || len(fixture.Store.Snapshot().Messages) != 1 {
		t.Fatal("incoming update replayed")
	}
	message := fixture.Store.Snapshot().Messages[0]
	submission, _ := message.Submission.Get()
	if submission != contracts.SubmissionStatusUnknown {
		t.Fatal("admission uncertainty was overwritten")
	}
}

func TestPairingHasPerMessageBaselineAndNoHistoryBackfill(t *testing.T) {
	fixture := fixture(t)
	old := fixture.add(t, contracts.RoleAssistant, "old history")
	fixture.Gateway.mu.Lock()
	fixture.Gateway.config.Owner = nil
	fixture.Gateway.mu.Unlock()
	pair, err := fixture.Gateway.Pair(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	update := Update{ID: 1, Message: &IncomingMessage{Text: "/start " + pair.Code}}
	update.Message.Chat.ID = raw(21)
	update.Message.Chat.Type = "private"
	update.Message.From.ID = raw(31)
	if err = fixture.Gateway.Receive(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	marker := mirrorOf(messageByID(fixture.Store.Snapshot(), old.ID))
	if !marker.Historical {
		t.Fatal("pairing did not record durable history baseline")
	}
	fixture.flush(t)
	for _, body := range fixture.Bodies {
		if strings.Contains(field(body, "text"), "old history") {
			t.Fatal("past conversation was backfilled")
		}
	}
}

func TestInterruptedConfigIsUnknownAndLegacyTextRemainsRaw(t *testing.T) {
	data := []byte(`{"enabled":false,"outbox":[{"id":"one","kind":"text","text":"\ud800","botId":"11","chatId":"21","userId":"31","status":"sending","attempts":1,"at":1}],"receipts":[{"id":1,"status":"processing"}],"resultKeys":[],"owner":{"chatId":"21","userId":"31","pairingId":"pair"},"bot":{"id":"11","username":"fixture_bot"}}`)
	config, changed, err := restoreConfig(data)
	if err != nil || !changed || config.Outbox[0].Status != OutboxUnknown || config.Receipts[0].Status != ReceiptUnknown {
		t.Fatal("interrupted persisted effects were made replayable", err)
	}
	encoded, err := json.Marshal(config)
	if err != nil || !strings.Contains(string(encoded), `\ud800`) {
		t.Fatal("legacy UTF16 user text changed")
	}
	for _, bad := range []string{`{"enabled":null}`, `{"combineReplies":"true"}`, `{"forwardMode":"anything"}`, `{"offset":-1}`} {
		if _, _, err = restoreConfig([]byte(bad)); err == nil {
			t.Fatal("invalid configuration was accepted")
		}
	}
}

func TestConfigureBoundaryAndSplitText(t *testing.T) {
	for _, input := range []contracts.RawObject{{"enabled": raw("true")}, {"enabled": json.RawMessage("null")}, {"combineReplies": raw(1)}, {"token": json.RawMessage("null")}} {
		if _, err := ReadConfigure(input); err == nil {
			t.Fatal("non-boolean/null setting accepted")
		}
	}
	parts := SplitText(strings.Repeat("a", 4095) + "😀tail")
	if len(parts) != 2 || contracts.UTF16Length(parts[0]) != 4095 || parts[1] != "😀tail" {
		t.Fatal("surrogate pair was split")
	}
	if MirrorText(`[file](file:///private/output.txt) [web](https://example.test)`) != `file [web](https://example.test)` {
		t.Fatal("local attachment target was exposed")
	}
}

func TestOwnedLoopsCancelAndJoinWithoutExternalEffects(t *testing.T) {
	fixture := fixture(t)
	started := make(chan struct{})
	var once sync.Once
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/getUpdates") {
			once.Do(func() { close(started) })
			<-request.Context().Done()
			return nil, request.Context().Err()
		}
		return reply(200, `{"ok":true,"result":[]}`), nil
	}
	fixture.Gateway.options.AutoPoll = true
	fixture.Gateway.Start()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("poll worker did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fixture.Gateway.Close(ctx); err != nil {
		t.Fatal("owned polling worker did not join", err)
	}
}

func TestMalformedConfigDoesNotReplaceOriginalFile(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "telegram.json")
	original := []byte(`{"outbox":[{"status":"invalid"}]}`)
	if err := os.WriteFile(file, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := readConfig(directory); err == nil {
		t.Fatal("malformed config loaded")
	}
	after, err := os.ReadFile(file)
	if err != nil || string(after) != string(original) {
		t.Fatal("validation mutated original config")
	}
}
