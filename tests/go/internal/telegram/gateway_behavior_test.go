package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfigurationRoutesVerifyBeforeReplacingPairingAndPersistDisconnection(t *testing.T) {
	fixture := fixture(t)
	mux := http.NewServeMux()
	RegisterRoutes(mux, fixture.Gateway)
	request := func(route, body string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		input := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
		input.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, input)
		return response
	}

	for _, body := range []string{`{"token":"bad"}`, `{"forwardMode":"all","combineReplies":false}`, `{"enabled":false}`, `{"enabled":true}`} {
		response := request("/api/telegram/config", body)
		want := 200
		if strings.Contains(body, `"bad"`) {
			want = 400
		}
		if response.Code != want || strings.Contains(response.Body.String(), fixtureToken) {
			t.Fatal("configuration route lost validation or disclosed a token")
		}
	}

	fixture.Gateway.mu.Lock()
	fixture.Gateway.config.Outbox = append(fixture.Gateway.config.Outbox, &OutboxItem{
		ID: "queued-disconnect", Kind: "text", Text: "isolated pending reply",
		BotID: "11", ChatID: "21", UserID: "31", PairingID: "fixture-pairing", Status: OutboxQueued,
	})
	fixture.Gateway.mu.Unlock()
	if response := request("/api/telegram/disconnect", `{"clearToken":true}`); response.Code != 200 {
		t.Fatal("disconnect route failed")
	}
	data, err := os.ReadFile(filepath.Join(fixture.Directory, "telegram.json"))
	if err != nil {
		t.Fatal(err)
	}
	config, _, err := restoreConfig(data)
	if err != nil || config.Enabled || config.Owner != nil || config.Token != nil || config.Bot != nil || config.Offset != 0 || config.Outbox[0].Status != OutboxFailed {
		t.Fatal("disconnect was not durably reflected in configuration and queued intent")
	}
	if response := request("/api/telegram/pair", `{}`); response.Code != 400 {
		t.Fatal("disabled bot issued a pairing code")
	}
}

func TestPairingPersistsOnlyHashedExpiringCodeAndBindsOnePrivateOwner(t *testing.T) {
	fixture := fixture(t)
	fixture.Gateway.mu.Lock()
	fixture.Gateway.config.Owner = nil
	fixture.Gateway.mu.Unlock()
	fixture.Gateway.options.Random = func(output []byte) (int, error) {
		return copy(output, bytes.Repeat([]byte{0x31}, len(output))), nil
	}
	pairing, err := fixture.Gateway.Pair(t.Context())
	if err != nil || len(pairing.Code) != 32 || pairing.ExpiresAt != fixture.Now.Load()+int64((10*time.Minute)/time.Millisecond) || !strings.HasSuffix(pairing.BotURL, "?start="+pairing.Code) {
		t.Fatal("pairing response did not describe its exact bounded identity")
	}
	data, err := os.ReadFile(filepath.Join(fixture.Directory, "telegram.json"))
	if err != nil || bytes.Contains(data, []byte(pairing.Code)) || !bytes.Contains(data, []byte(digest(pairing.Code))) || bytes.Contains(raw(fixture.Gateway.Status()), []byte(pairing.Code)) {
		t.Fatal("pairing code was stored or exposed outside its one-time response")
	}
	wrong := behaviorUpdate(t, 100, "/start "+strings.Repeat("0", 32))
	if err := fixture.Gateway.Receive(t.Context(), wrong); err != nil {
		t.Fatal(err)
	}
	if string(fixture.Gateway.Status()["paired"]) != "false" {
		t.Fatal("incorrect pairing secret claimed an owner")
	}
	if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, 101, "/start "+pairing.Code)); err != nil {
		t.Fatal(err)
	}
	if string(fixture.Gateway.Status()["paired"]) != "true" || fixture.Admitted.Load() != 0 {
		t.Fatal("pairing did not bind exactly one owner without executing work")
	}
	if _, err := fixture.Gateway.Pair(t.Context()); !errors.Is(err, ErrConfig) {
		t.Fatal("paired owner could be replaced by issuing another code")
	}
	fixture.Gateway.mu.Lock()
	if fixture.Gateway.config.Pairing != nil || fixture.Gateway.config.Owner.ChatID != "21" || fixture.Gateway.config.Owner.SyncVersion != 1 {
		t.Error("pairing retained a reusable secret or omitted its history baseline")
	}
	fixture.Gateway.mu.Unlock()
}

func TestVerificationRejectsWebhookMalformedBotAndUnknownTransportWithoutChangingOwner(t *testing.T) {
	for _, scenario := range []string{"webhook", "not-bot", "invalid-name", "invalid-id", "network", "oversized"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			fixture.Gateway.options.HTTP = httpFunc(func(request *http.Request) (*http.Response, error) {
				if scenario == "network" {
					return nil, errors.New("private transport detail " + fixtureToken)
				}
				if scenario == "oversized" {
					response := reply(200, `{}`)
					response.ContentLength = MaxResponseBytes + 1
					return response, nil
				}
				if strings.HasSuffix(request.URL.Path, "/getWebhookInfo") {
					return reply(200, `{"ok":true,"result":{"url":"https://invalid.example/webhook"}}`), nil
				}
				data := map[string]any{"id": 11, "is_bot": true, "username": "fixture_bot"}
				switch scenario {
				case "not-bot":
					data["is_bot"] = false
				case "invalid-name":
					data["username"] = "unsafe/name"
				case "invalid-id":
					data["id"] = "11"
				}
				return reply(200, string(raw(map[string]any{"ok": true, "result": data}))), nil
			})
			before := fixture.Gateway.config.Owner.PairingID
			token := "654321:another_synthetic_fixture_token"
			if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{Token: &token}); err == nil || strings.Contains(err.Error(), fixtureToken) {
				t.Fatal("unverified configuration was accepted or exposed private transport detail")
			}
			if fixture.Gateway.config.Owner == nil || fixture.Gateway.config.Owner.PairingID != before || *fixture.Gateway.config.Token != fixtureToken {
				t.Fatal("failed verification replaced the existing pairing")
			}
		})
	}
}

func TestConfigurationCommitFailuresPreservePolicyPairingAndPriorDiskBytes(t *testing.T) {
	fixture := fixture(t)
	before, err := os.ReadFile(fixture.Gateway.file)
	if err != nil {
		t.Fatal(err)
	}
	original := fixture.Gateway.file
	fixture.Gateway.file = fixture.Directory
	mode, combine := ForwardAll, false
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{ForwardMode: &mode, CombineReplies: &combine}); !errors.Is(err, ErrConfig) {
		t.Fatal("failed policy persistence was reported as committed")
	}
	if fixture.Gateway.config.ForwardMode != ForwardUnread || !fixture.Gateway.config.CombineReplies {
		t.Fatal("failed policy persistence changed active policy")
	}
	token := "654321:another_synthetic_fixture_token"
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{Token: &token}); !errors.Is(err, ErrConfig) || fixture.Gateway.config.Owner == nil || *fixture.Gateway.config.Token != fixtureToken {
		t.Fatal("failed token persistence discarded the prior owner")
	}
	fixture.Gateway.file = original
	after, err := os.ReadFile(original)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed configuration altered the durable original")
	}
}

func TestBackupConfigurationValidationRejectsInvalidPersistentIntentsWithoutRepairingInput(t *testing.T) {
	fixture := fixture(t)
	baseline := raw(fixture.Gateway.config)
	for _, scenario := range []string{"offset", "mode", "outbox-null", "receipt-null", "outbox-status", "outbox-identity", "document-reference", "receipt-status", "owner", "bot", "pairing"} {
		t.Run(scenario, func(t *testing.T) {
			value := object(fixture.Gateway.config)
			switch scenario {
			case "offset":
				value["offset"] = raw(-1)
			case "mode":
				value["forwardMode"] = raw("unknown")
			case "outbox-null":
				value["outbox"] = raw(nil)
			case "receipt-null":
				value["receipts"] = raw(nil)
			case "owner":
				value["owner"] = raw(Owner{ChatID: "21", UserID: "31"})
			case "bot":
				value["bot"] = raw(Bot{ID: "11", Username: "bad/name"})
			case "pairing":
				value["pairing"] = raw(Pairing{Hash: "not-a-hash", ExpiresAt: 1})
			case "receipt-status":
				value["receipts"] = raw([]Receipt{{ID: 1, Status: "future"}})
			default:
				item := &OutboxItem{ID: "bounded-intent", Kind: "text", Text: "isolated", BotID: "11", ChatID: "21", UserID: "31", Status: OutboxQueued}
				if scenario == "outbox-status" {
					item.Status = "future"
				} else if scenario == "outbox-identity" {
					item.ID = ""
				} else {
					item.Kind = "document"
				}
				value["outbox"] = raw([]*OutboxItem{item})
			}
			data := raw(value)
			if !errors.Is(ValidateBackupConfig(data), ErrConfig) || !bytes.Equal(data, raw(value)) {
				t.Fatal("invalid durable intent was accepted or silently repaired")
			}
		})
	}
	if err := ValidateBackupConfig(baseline); err != nil {
		t.Fatal("unchanged valid backup was rejected", err)
	}
}

func TestStatusUsesFixedBoundedDeliveryMetadataAndRedactsConfiguredToken(t *testing.T) {
	fixture := fixture(t)
	fixture.Gateway.mu.Lock()
	fixture.Gateway.config.LastError = pointer(strings.Repeat("x", 550) + fixtureToken)
	fixture.Gateway.config.PollError = pointer("network " + fixtureToken)
	fixture.Gateway.config.Outbox = []*OutboxItem{
		{Status: OutboxFailed, At: 1, FailureReason: "arbitrary private diagnostic"},
		{Status: OutboxUnknown, At: 2, LastAttemptAt: 3},
		{Status: OutboxQueued}, {Status: OutboxSending},
	}
	fixture.Gateway.mu.Unlock()
	status := fixture.Gateway.Status()
	encoded := raw(status)
	var delivery struct {
		Failed    int `json:"failed"`
		Unknown   int `json:"unknown"`
		LastIssue struct {
			Reason string `json:"reason"`
			At     int64  `json:"at"`
		} `json:"lastIssue"`
	}
	if json.Unmarshal(status["delivery"], &delivery) != nil || delivery.Failed != 1 || delivery.Unknown != 1 || delivery.LastIssue.Reason != "unconfirmed" || delivery.LastIssue.At != 3 || string(status["pendingOutbound"]) != "2" || bytes.Contains(encoded, []byte(fixtureToken)) || bytes.Contains(encoded, []byte("arbitrary private diagnostic")) {
		t.Fatal("status disclosed raw details or misrepresented delivery state")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := fixture.Gateway.Pair(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled administration crossed its acquisition boundary")
	}
}

func TestPairAndDisconnectRoutesPreserveTokenUntilExplicitlyRequestedAndRejectUnknownFields(t *testing.T) {
	fixture := fixture(t)
	mux := http.NewServeMux()
	RegisterRoutes(mux, fixture.Gateway)
	request := func(route, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		input := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
		input.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, input)
		return response
	}
	for _, body := range []string{`{"unexpected":true}`, `{"clearToken":false,"unexpected":true}`, `{"clearToken":null}`} {
		if response := request("/api/telegram/disconnect", body); response.Code != 400 || fixture.Gateway.config.Owner == nil {
			t.Fatal("invalid disconnect body changed the existing pairing")
		}
	}
	if response := request("/api/telegram/config", `not-json`); response.Code != 400 {
		t.Fatal("malformed configuration JSON crossed the route boundary")
	}
	if response := request("/api/telegram/disconnect", `{}`); response.Code != 200 || fixture.Gateway.config.Token == nil || fixture.Gateway.config.Owner != nil {
		t.Fatal("ordinary disconnect cleared the saved token or retained an active owner")
	}
	if response := request("/api/telegram/config", `{"enabled":true}`); response.Code != 200 {
		t.Fatal("saved token could not be explicitly re-enabled")
	}
	response := request("/api/telegram/pair", `{}`)
	var result PairResult
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Code) != 32 || fixture.Gateway.config.Owner != nil {
		t.Fatal("pair route did not expose one bounded challenge without claiming an owner")
	}
}
