package telegram

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRejectedPhotoFallsBackOnceWithoutRetryingUnknownDelivery(t *testing.T) {
	fixture := fixture(t)
	ctx := context.Background()
	attachment, err := fixture.Gateway.options.Attachments.Put(ctx, "image.png", "image/png", []byte{137, 80, 78, 71, 13, 10, 26, 10, 0})
	if err != nil {
		t.Fatal(err)
	}
	message := fixture.add(t, contracts.RoleAssistant, "")
	if _, err = fixture.Store.Update(ctx, message.ID, contracts.MessagePatch{"attachments": raw([]contracts.Attachment{attachment})}); err != nil {
		t.Fatal(err)
	}
	methods := []string{}
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		methods = append(methods, request.URL.Path)
		if strings.HasSuffix(request.URL.Path, "/sendPhoto") {
			return reply(400, `{"ok":false,"error_code":400}`), nil
		}
		return reply(200, `{"ok":true,"result":{"message_id":43}}`), nil
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if len(methods) != 2 || !strings.HasSuffix(methods[0], "/sendPhoto") || !strings.HasSuffix(methods[1], "/sendDocument") {
		t.Fatal("rejected photo did not use exactly one original-file fallback")
	}
}

func TestUnsafeRemoteAttachmentPathNeverFetchesOrAdmits(t *testing.T) {
	fixture := fixture(t)
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/getFile") {
			t.Error("unsafe attachment requested a second URL")
		}
		return reply(200, `{"ok":true,"result":{"file_path":"documents/../private","file_size":1}}`), nil
	}
	update, err := ReadUpdate([]byte(`{"update_id":9,"message":{"message_id":1,"chat":{"id":21,"type":"private"},"from":{"id":31},"document":{"file_id":"fixture-file","file_name":"a.txt","file_size":1}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = fixture.Gateway.Receive(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	if fixture.Sent.Load() != 1 || fixture.Admitted.Load() != 0 {
		t.Fatal("unsafe attachment crossed admission")
	}
	state := fixture.Store.Snapshot()
	if len(state.Messages) != 1 || statusOf(state.Messages[0]) != contracts.MessageStatus(contracts.TaskStatusFailed) {
		t.Fatal("failed intake did not retain its durable message")
	}
}

func TestDownloadCannotApplyIntoDifferentConversation(t *testing.T) {
	fixture := fixture(t)
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/getFile") {
			if err := fixture.Store.Mutate(context.Background(), func(state *contracts.State) error {
				state.ConversationID = "00000000-0000-4000-8000-000000000009"
				state.Messages = nil
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			return reply(200, `{"ok":true,"result":{"file_path":"documents/a.txt","file_size":1}}`), nil
		}
		return reply(200, "a"), nil
	}
	update, err := ReadUpdate([]byte(`{"update_id":10,"message":{"message_id":1,"chat":{"id":21,"type":"private"},"from":{"id":31},"document":{"file_id":"fixture-file","file_name":"a.txt","file_size":1}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = fixture.Gateway.Receive(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	if fixture.Admitted.Load() != 0 || len(fixture.Store.Snapshot().Messages) != 0 {
		t.Fatal("late attachment created work in a new conversation")
	}
}

func TestLegacyUTF16MirrorAndLocalLinkRemainExact(t *testing.T) {
	fixture := fixture(t)
	var message contracts.ChatMessage
	if err := json.Unmarshal([]byte(`{"role":"assistant","text":"a\ud800 [local](file:///private/a.txt) 😀","status":"completed"}`), &message); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Store.Add(context.Background(), &message); err != nil {
		t.Fatal(err)
	}
	fixture.Send = func(*http.Request) (*http.Response, error) {
		return reply(200, `{"ok":true,"result":{"message_id":44}}`), nil
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if len(fixture.Bodies) != 1 {
		t.Fatal("legacy mirror was not scheduled")
	}
	units, err := contracts.DecodeJSONTextUnits(fixture.Bodies[0]["text"])
	wanted, decodeErr := contracts.DecodeJSONTextUnits([]byte(`"a\ud800 local 😀"`))
	if err != nil || decodeErr != nil || string(raw(units)) != string(raw(wanted)) {
		t.Fatal("legacy text changed or private target escaped")
	}
}

func TestOutgoingMalformedAcknowledgementIsNeverReplayed(t *testing.T) {
	for _, response := range []string{`{"ok":true,"result":{}}`, `{"ok":false,"error_code":500}`, `not-json`} {
		t.Run(response[:min(len(response), 12)], func(t *testing.T) {
			fixture := fixture(t)
			fixture.Send = func(*http.Request) (*http.Response, error) { return reply(200, response), nil }
			fixture.add(t, contracts.RoleAssistant, "reply")
			fixture.flush(t)
			fixture.Now.Add(2)
			fixture.flush(t)
			fixture.flush(t)
			if fixture.Sent.Load() != 1 {
				t.Fatal("unconfirmed external delivery was retried")
			}
		})
	}
}
