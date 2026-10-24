package voice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	"github.com/Stephen-Sim/dant/core/internal/security"
)

type VoiceKeys interface {
	Set(context.Context, string) (security.KeyStatus, error)
	Clear(context.Context) (security.KeyStatus, error)
}

type RouteOptions struct {
	Service *Service
	Keys    VoiceKeys
	Ready   func() bool
	Changed func()
}

func voiceRouteError(err error) error {
	var input *VoiceInputError
	if errors.As(err, &input) {
		return input
	}
	if errors.Is(err, ErrCallInput) || errors.Is(err, security.ErrAPIKey) {
		return httpapi.Failure(400, "invalid_call", "The voice request is invalid.")
	}
	if errors.Is(err, ErrVoiceBusy) || errors.Is(err, ErrVoiceCancelled) {
		return httpapi.Failure(409, "call_changed", "The voice call changed. Refresh its current state.")
	}
	if errors.Is(err, ErrVoiceConnection) || errors.Is(err, ErrVoiceKey) {
		return httpapi.Failure(502, "voice_unavailable", "The voice service could not connect.")
	}
	return err
}

func (err *VoiceInputError) UnconfirmedOutcome() bool { return err.UnknownOutcome }

func RegisterRoutes(mux *http.ServeMux, options RouteOptions) {
	service := options.Service
	wrap := func(handler httpapi.Handler) httpapi.Handler {
		return func(writer http.ResponseWriter, request *http.Request) error {
			return voiceRouteError(handler(writer, request))
		}
	}
	httpapi.Register(mux, "POST /api/call", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 1024*1024)
		if err != nil {
			return err
		}
		if options.Ready != nil && !options.Ready() {
			return httpapi.Failure(409, "worker_offline", "Connect the work computer before starting a call.")
		}
		sdp, err := httpapi.String(body, "sdp", true)
		if err != nil {
			return err
		}
		provider, err := httpapi.String(body, "provider", false)
		if err != nil {
			return err
		}
		key, err := httpapi.String(body, "apiKey", false)
		if err != nil {
			return err
		}
		if key != "" {
			if provider != "api" {
				return ErrCallInput
			}
			key, err = security.ValidateAPIKey(key)
			if err != nil {
				return err
			}
		}
		result, err := service.StartCall(request.Context(), CallStartRequest{SDP: sdp, Provider: provider, APIKey: key})
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	}))
	httpapi.Register(mux, "POST /api/call/connected", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 4096)
		if err != nil {
			return err
		}
		id, err := httpapi.String(body, "callId", true)
		if err != nil {
			return err
		}
		call, err := service.ConfirmConnected(id)
		if err != nil {
			return err
		}
		if call == nil {
			return ErrVoiceCancelled
		}
		connected, _ := call.ConnectedAt.Get()
		return httpapi.JSON(writer, map[string]any{"connected": true, "callId": id, "connectedAt": connected})
	}))
	httpapi.Register(mux, "POST /api/call/stop", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 4096)
		if err != nil {
			return err
		}
		current := service.Snapshot()
		id, err := httpapi.String(body, "callId", current != nil)
		if err != nil {
			return err
		}
		if current == nil {
			return httpapi.JSON(writer, map[string]bool{"stopped": true})
		}
		if err = service.Stop(request.Context(), id); err != nil {
			return err
		}
		return httpapi.JSON(writer, map[string]any{"stopped": true, "callId": id})
	}))
	httpapi.Register(mux, "POST /api/realtime/message", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 1024*1024)
		if err != nil {
			return err
		}
		for _, key := range []string{"callId", "clientMessageId", "text"} {
			if _, err = httpapi.String(body, key, true); err != nil {
				return err
			}
		}
		if attachments, present := body["attachments"]; present {
			var values []json.RawMessage
			if json.Unmarshal(attachments, &values) != nil || values == nil || len(values) > 0 {
				return ErrCallInput
			}
		}
		callID, _ := httpapi.String(body, "callId", true)
		clientID, _ := httpapi.String(body, "clientMessageId", true)
		text, _ := httpapi.String(body, "text", true)
		var conversationID *string
		if raw, present := body["conversationId"]; present {
			id, err := httpapi.String(body, "conversationId", true)
			if err != nil || !contracts.ValidUnicodeJSON(raw) || id == "" || len(id) > nativeConversationIDLimit {
				return ErrCallInput
			}
			conversationID = &id
		}
		var reply *string
		if value, present := body["replyTo"]; present && string(value) != "null" {
			var id string
			if json.Unmarshal(value, &id) != nil {
				return ErrCallInput
			}
			reply = &id
		}
		result, err := service.NativeMessage(request.Context(), NativeMessage{ClientMessageID: clientID, Text: text, CallID: callID, ReplyTo: reply, ConversationID: conversationID})
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	}))
	httpapi.Register(mux, "GET /api/voices", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		result, err := service.Voices(request.Context())
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	}))
	if options.Keys == nil {
		return
	}
	httpapi.Register(mux, "POST /api/voice-key", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 8192)
		if err != nil {
			return err
		}
		key, err := httpapi.String(body, "key", true)
		if err != nil {
			return err
		}
		var status security.KeyStatus
		err = service.changeKey(func() error {
			var err error
			status, err = options.Keys.Set(request.Context(), key)
			return err
		})
		if err != nil {
			return err
		}
		if options.Changed != nil {
			options.Changed()
		}
		return httpapi.JSON(writer, map[string]any{"ok": true, "key": status})
	}))
	httpapi.Register(mux, "DELETE /api/voice-key", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		var status security.KeyStatus
		err := service.changeKey(func() error {
			var err error
			status, err = options.Keys.Clear(request.Context())
			return err
		})
		if err != nil {
			return err
		}
		if options.Changed != nil {
			options.Changed()
		}
		return httpapi.JSON(writer, map[string]any{"ok": true, "key": status})
	}))
}

var _ VoiceKeys = (*security.VoiceKeyStore)(nil)
