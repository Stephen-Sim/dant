package voice

import (
	"context"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (service *Service) Message(ctx context.Context, input MessageOptions) (InputResult, error) {
	if input.Message == nil || len(input.Message.Attachments) > 0 {
		return InputResult{}, ErrCallInput
	}
	call := service.Snapshot()
	if call == nil || call.ID != input.CallID {
		return InputResult{}, ErrVoiceCancelled
	}

	api, native := service.providers()
	if call.Provider == "api" {
		if err := api.ConversationReady(ctx, input.CallID); err != nil {
			return InputResult{}, err
		}
		if service.options.RememberCallInput == nil {
			return InputResult{}, ErrVoiceContext
		}
		if err := service.options.RememberCallInput(ctx, input.Message, input.CallID); err != nil {
			return InputResult{}, err
		}
		return api.Message(ctx, input)
	}

	result, err := native.SubmitMessage(ctx, input)
	if err != nil {
		return InputResult{}, err
	}
	return InputResult{MessageID: result.Message.ID, CallID: result.CallID, Status: contracts.LiveContextStatusSubmitted, Submission: result.Submission}, nil
}

func (service *Service) NativeMessage(ctx context.Context, input NativeMessage) (NativeMessageResult, error) {
	call := service.Snapshot()
	if call == nil || call.ID != input.CallID || call.Provider != "subscription" {
		return NativeMessageResult{}, ErrVoiceCancelled
	}

	_, native := service.providers()
	return native.Message(ctx, input)
}

func (service *Service) SyncMemory(ctx context.Context, callID, memory string) ContextResult {
	call := service.Snapshot()
	if call == nil || call.ID != callID {
		return ContextResult{CallID: callID, Kind: "memory", Status: contracts.LiveContextStatusCancelled}
	}

	api, native := service.providers()
	if call.Provider == "api" {
		return api.SyncMemory(ctx, callID, memory)
	}
	return native.SyncMemory(ctx, callID, memory)
}

func (service *Service) SyncContext(ctx context.Context, callID, kind string, message *contracts.ChatMessage) ContextResult {
	call := service.Snapshot()
	if call == nil || call.ID != callID {
		return ContextResult{CallID: callID, Kind: kind, Status: contracts.LiveContextStatusCancelled}
	}

	api, native := service.providers()
	if call.Provider == "api" {
		return api.SyncContext(ctx, callID, kind, message)
	}
	return native.SyncContext(ctx, callID, kind, message)
}

func (service *Service) APIState() APIState {
	api, _ := service.providers()
	if api == nil {
		return APIState{}
	}
	return api.Snapshot()
}

func (service *Service) NativeState() NativeState {
	_, native := service.providers()
	if native == nil {
		return NativeState{Model: NativeRealtimeModel}
	}
	return native.Snapshot()
}

func (service *Service) Voices(ctx context.Context) (contracts.RawObject, error) {
	_, native := service.providers()
	if native == nil {
		return nil, ErrVoiceConnection
	}
	result, err := native.ListVoices(ctx)
	if err != nil {
		return nil, err
	}

	result["nativeV3"] = objectField(result, "voices")["v3"]
	result["apiV2"] = rawValue(APIVoices())
	result["defaultApi"] = rawValue("marin")
	result["api"] = rawValue(map[string]any{"voices": APIVoices(), "default": "marin"})
	return result, nil
}
