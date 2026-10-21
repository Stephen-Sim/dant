package telegram

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMirrorAndResultReceiptFailuresCannotSendContentOrAdmitMoreWork(t *testing.T) {
	for _, scenario := range []string{"assistant", "historical", "interrupted-mirror", "interrupted-result", "legacy-result", "result"} {
		for failAt := 1; failAt <= 3; failAt++ {
			t.Run(scenario+string(rune('0'+failAt)), func(t *testing.T) {
				fixture := fixture(t)
				message := fixture.add(t, contracts.RoleAssistant, "synthetic reply")
				if strings.HasSuffix(scenario, "result") || scenario == "historical" {
					task := ownedTask(t, fixture, contracts.TaskStatusCompleted)
					if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"taskId": raw(task.ID)}); err != nil {
						t.Fatal(err)
					}
					if scenario == "interrupted-result" {
						if _, err := fixture.Store.Update(t.Context(), task.ID, contracts.MessagePatch{"telegramDelivery": raw(deliveryMarker{Key: resultKey(task, "fixture-pairing"), PairingID: "fixture-pairing", Status: MirrorScheduling})}); err != nil {
							t.Fatal(err)
						}
					}
					if scenario == "legacy-result" {
						fixture.Gateway.config.ResultKeys = []string{resultKey(task, "fixture-pairing")}
					}
				}
				if scenario == "historical" {
					fixture.Gateway.config.Owner.SyncVersion = 0
				}
				if scenario == "interrupted-mirror" {
					if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"telegramMirror": raw(mirrorMarker{PairingID: "fixture-pairing", Text: mirrorStatus(MirrorScheduling)})}); err != nil {
						t.Fatal(err)
					}
				}
				failure := &interruptedMirrorPersistence{Persistence: fixture.Store, failAt: failAt}
				fixture.Gateway.options.Store = failure
				err := fixture.Gateway.Scan(t.Context())
				if failure.calls >= failAt && err == nil || fixture.Sent.Load() != 0 || fixture.Admitted.Load() != 0 {
					t.Fatal("a failed receipt was treated as committed or triggered external work", err)
				}
				if fixture.Store.ConversationID() != fixture.Gateway.config.Owner.ConversationID {
					t.Fatal("receipt failure replaced the conversation owner")
				}
			})
		}
	}
}

func TestDisabledOrCancelledTelegramFlushNeverStartsTransportAndStillRetainsReceipts(t *testing.T) {
	for _, scenario := range []string{"disabled", "missing-owner", "cancel-after-send", "failed-final-receipt"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			fixture.add(t, contracts.RoleAssistant, "synthetic queued reply")
			fixture.flush(t)
			fixture.Now.Add(2)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			original := fixture.Gateway.file
			switch scenario {
			case "disabled":
				fixture.Gateway.config.Enabled = false
			case "missing-owner":
				fixture.Gateway.config.Owner = nil
			case "cancel-after-send", "failed-final-receipt":
				fixture.Send = func(*http.Request) (*http.Response, error) {
					if scenario == "cancel-after-send" {
						cancel()
					} else {
						fixture.Gateway.file = fixture.Directory
					}
					return reply(200, `{"ok":true,"result":{"message_id":42}}`), nil
				}
			}
			_, err := fixture.Gateway.Flush(ctx)
			fixture.Gateway.file = original
			if strings.HasPrefix(scenario, "cancel") && !errors.Is(err, context.Canceled) || scenario == "failed-final-receipt" && err == nil {
				t.Fatal("unconfirmed or cancelled flush lost its result", err)
			}
			want := int32(0)
			if scenario == "cancel-after-send" || scenario == "failed-final-receipt" {
				want = 1
			}
			if fixture.Sent.Load() != want {
				t.Fatal("flush crossed its cancellation or ownership boundary")
			}
			if want == 1 && fixture.Gateway.config.Outbox[0].Status != OutboxSent {
				t.Fatal("a confirmed send was incorrectly made retryable")
			}
		})
	}
}

func TestTelegramFixedTextBoundariesPreserveUnicodeAndRejectMalformedConfiguration(t *testing.T) {
	fixture := fixture(t)
	if fixture.Gateway.stateLabel("future-state") != fixture.Gateway.stateLabel("unknown") {
		t.Fatal("unknown state had an invented fixed label")
	}
	if value := fixture.Gateway.publicText("synthetic\x00\x7ftext"); strings.ContainsAny(value, "\x00\x7f") {
		t.Fatal("control characters escaped fixed diagnostic text")
	}
	for _, input := range []contracts.RawObject{{"token": raw(false)}, {"combineReplies": raw("false")}} {
		if _, err := ReadConfigure(input); !errors.Is(err, ErrConfig) {
			t.Fatal("non-typed configuration was accepted", err)
		}
	}
	if _, err := mirrorUnits(raw(false), "", ""); !errors.Is(err, ErrIncoming) {
		t.Fatal("malformed text was mirrored", err)
	}
	units := utf16.Encode([]rune(strings.Repeat("x", MaxTextUnits-1) + "😀tail"))
	chunks := splitUnits(units)
	if len(chunks) != 2 || len(chunks[0]) != MaxTextUnits-1 || len(chunks[1]) != 6 {
		t.Fatal("legacy UTF-16 chunk boundary split an emoji")
	}
	if chunks := SplitText(strings.Repeat("x", MaxTextUnits-1) + "😀tail"); len(chunks) != 2 || chunks[1] != "😀tail" {
		t.Fatal("text chunk boundary corrupted an emoji")
	}
	if units, err := mirrorUnits(raw("synthetic "+fixtureToken), "", fixtureToken); err != nil || string(utf16.Decode(units)) != "synthetic [redacted]" {
		t.Fatal("Bot token escaped mirror redaction", err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, fixture.Gateway)
	for _, body := range []string{`{"clearToken":"false"}`, `{"other":true}`} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest("POST", "http://localhost/api/telegram/disconnect", strings.NewReader(body)))
		if response.Code != 400 {
			t.Fatal("malformed disconnect mutated Telegram configuration")
		}
	}
}

func TestUnconfiguredGatewayCannotPersistIntoAReplacementDirectory(t *testing.T) {
	fixture := fixture(t)
	parent := t.TempDir()
	directory := filepath.Join(parent, "original")
	gateway, err := Open(t.Context(), directory, fixture.Gateway.options)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(t.Context())
	if err := os.Rename(directory, filepath.Join(parent, "retained")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(directory, "telegram.json")
	if err := os.WriteFile(name, []byte("replacement marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	disabled := false
	if _, err := gateway.Configure(t.Context(), ConfigureInput{Enabled: &disabled}); !errors.Is(err, ErrConfig) {
		t.Fatal("gateway adopted the replacement directory's identity", err)
	}
	if data, err := os.ReadFile(name); err != nil || string(data) != "replacement marker" {
		t.Fatal("gateway replaced an unrelated configuration", err)
	}
}
