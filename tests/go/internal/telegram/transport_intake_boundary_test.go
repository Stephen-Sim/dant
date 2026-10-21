package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type unreadableTelegramAttachment struct {
	Attachments
	err error
}

func (attachment unreadableTelegramAttachment) Read(context.Context, string) (contracts.Attachment, []byte, error) {
	return contracts.Attachment{Name: "fixture.json"}, nil, attachment.err
}

func TestTelegramSendRejectsUnreadableOrInvalidAttachmentsBeforeHTTP(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, nil} {
		fixture := fixture(t)
		fixture.Gateway.options.Attachments = unreadableTelegramAttachment{Attachments: fixture.Gateway.options.Attachments, err: failure}
		_, _, err := fixture.Gateway.send(t.Context(), fixtureToken, []*OutboxItem{{Kind: "file", AttachmentID: "synthetic-file"}}, false)
		var classified *OperationError
		if !errors.As(err, &classified) || classified.Reason != "attachment" || classified.Unknown || fixture.Sent.Load() != 0 {
			t.Fatal("local attachment failure reached HTTP or became an unknown send", err)
		}
	}
}

func TestTelegramMultipartPreservesAuthoredCaptionAndSilentFlag(t *testing.T) {
	fixture := fixture(t)
	attachment, err := fixture.Gateway.options.Attachments.Put(t.Context(), "fixture.txt", "text/plain", []byte("synthetic content"))
	if err != nil {
		t.Fatal(err)
	}
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/sendDocument") || request.ParseMultipartForm(1024) != nil {
			t.Fatal("document send did not contain bounded multipart data")
		}
		defer request.MultipartForm.RemoveAll()
		if request.FormValue("caption") != "保留 original caption" || request.FormValue("disable_notification") != "true" || request.FormValue("chat_id") != "21" {
			t.Fatal("document send changed its caption, recipient or notification policy")
		}
		part, _, err := request.FormFile("document")
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(part)
		closeErr := part.Close()
		if readErr != nil || closeErr != nil || string(data) != "synthetic content" {
			t.Fatal("document bytes changed during multipart construction", readErr, closeErr)
		}
		return reply(200, `{"ok":true,"result":{"message_id":43}}`), nil
	}
	id, method, err := fixture.Gateway.send(t.Context(), fixtureToken, []*OutboxItem{{Kind: "file", AttachmentID: attachment.ID, ChatID: "21", Caption: "保留 original caption"}}, true)
	if err != nil || id != "43" || method != "sendDocument" || fixture.Sent.Load() != 1 {
		t.Fatal("document send did not retain its exact acknowledgement", id, method, err)
	}
}

func TestTelegramMalformedLegacyTextAndExpiredRequestStopBeforeAdmission(t *testing.T) {
	fixture := fixture(t)
	_, _, err := fixture.Gateway.send(t.Context(), fixtureToken, []*OutboxItem{{Kind: "text", Text: "original", decodedText: "original", legacyText: json.RawMessage(`"\uZZZZ"`)}}, false)
	var classified *OperationError
	if !errors.As(err, &classified) || classified.Reason != "invalid-response" || fixture.Sent.Load() != 0 {
		t.Fatal("malformed legacy text was normalized and sent", err)
	}
	ctx, cancel := context.WithDeadline(t.Context(), time.Unix(1, 0))
	defer cancel()
	if reason := failureReason(ctx, io.ErrUnexpectedEOF); reason != "timeout" {
		t.Fatal("expired request was misclassified", reason)
	}
	fixture.Send = func(*http.Request) (*http.Response, error) { return nil, ctx.Err() }
	if _, err := fixture.Gateway.api(ctx, fixtureToken, "sendMessage", []byte(`{}`), ""); !errors.As(err, &classified) || classified.Reason != "timeout" || !classified.Unknown {
		t.Fatal("expired write lost its unconfirmed outcome", err)
	}
}

func TestTelegramPhotoSelectionUsesBoundedDimensionsAndKeepsItsChosenBytes(t *testing.T) {
	fixture := fixture(t)
	update := behaviorUpdate(t, 100, "")
	update.Message.Photo = []File{
		{ID: "invalid-dimension", Width: maxIncomingImageDimension + 1, Height: 100},
		{ID: "smaller", Width: 1, Height: 1},
		{ID: "selected", Width: 20, Height: 10},
	}
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/getFile") {
			fixture.mu.Lock()
			selected := field(fixture.Bodies[len(fixture.Bodies)-1], "file_id")
			fixture.mu.Unlock()
			if selected != "selected" {
				t.Fatal("photo dimensions selected an invalid or smaller candidate")
			}
			return reply(200, `{"ok":true,"result":{"file_path":"photos/selected.png","file_size":9}}`), nil
		}
		return reply(200, string([]byte{137, 80, 78, 71, 13, 10, 26, 10, 0})), nil
	}
	if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
		t.Fatal(err)
	}
	state := fixture.Store.Snapshot()
	if fixture.Admitted.Load() != 1 || len(state.Messages) != 1 || len(state.Messages[0].Attachments) != 1 {
		t.Fatal("selected photo was not durably admitted exactly once")
	}
}

func TestTelegramPolicyChangesPersistTogetherWithoutStartingPolling(t *testing.T) {
	fixture := fixture(t)
	mode, combine := ForwardAll, false
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{ForwardMode: &mode, CombineReplies: &combine}); err != nil {
		t.Fatal(err)
	}
	if fixture.Gateway.config.ForwardMode != ForwardAll || fixture.Gateway.config.CombineReplies || fixture.Sent.Load() != 0 || fixture.Gateway.loopDone != nil {
		t.Fatal("policy update lost its values or started unsolicited network work")
	}
	if fixture.Gateway.suppress(nil, "text", "") {
		t.Fatal("a missing message was suppressed as if it had a receipt")
	}
	status := MirrorSuppressed
	message := &contracts.ChatMessage{Role: contracts.RoleAssistant}
	message.TelegramMirror = object(mirrorMarker{PairingID: fixture.Gateway.config.Owner.PairingID, Text: &status})
	if !fixture.Gateway.suppress(message, "text", "") {
		t.Fatal("explicit suppression was undone by an all-messages policy")
	}
}
