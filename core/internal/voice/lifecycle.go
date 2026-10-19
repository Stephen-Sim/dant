package voice

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type CallEndReason string

const (
	CallEndUser            CallEndReason = "user"
	CallEndTool            CallEndReason = "tool"
	CallEndConnectionLost  CallEndReason = "connection-lost"
	CallEndShutdown        CallEndReason = "shutdown"
	CallEndStartFailed     CallEndReason = "start-failed"
	maxCallReceipts                      = 4096
	callLifecycleIOTimeout               = 10 * time.Second
)

type EndedEvent struct {
	CallID      string
	Provider    string
	Reason      CallEndReason
	ConnectedAt float64
}
type EndedHandler func(context.Context, EndedEvent) error
type callReceipt struct {
	conversation string
	call         contracts.Call
	once         sync.Once
	err          error
}

var ErrCallLifecycle = errors.New("call_history_unconfirmed")

func (api *API) setEnded(handler EndedHandler) {
	api.mu.Lock()
	api.ended = handler
	api.mu.Unlock()
}

func (native *Native) setEnded(handler EndedHandler) {
	native.mu.Lock()
	native.ended = handler
	native.mu.Unlock()
}

func (service *Service) rememberCall(input CallStartRequest) error {
	conversation := ""
	if service.options.History != nil {
		conversation = service.options.History.Snapshot().ConversationID
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.receipts) >= maxCallReceipts || service.receipts[input.CallID] != nil {
		return ErrVoiceBusy
	}
	service.receipts[input.CallID] = &callReceipt{conversation: conversation, call: contracts.Call{ID: input.CallID, Provider: input.Provider, Started: contracts.Some(float64(service.options.Now().UnixMilli())), Status: contracts.VoiceCallStatusConnecting}}
	return nil
}

func (service *Service) ended(ctx context.Context, event EndedEvent) error {
	service.mu.Lock()
	receipt := service.receipts[event.CallID]
	if receipt == nil || receipt.call.Provider != event.Provider {
		service.mu.Unlock()
		return nil
	}
	call := receipt.call
	if event.ConnectedAt > 0 {
		call.ConnectedAt = contracts.Some(event.ConnectedAt)
	}
	service.mu.Unlock()
	receipt.once.Do(func() {
		bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), callLifecycleIOTimeout)
		defer cancel()
		if connected, ok := call.ConnectedAt.Get(); ok && connected > 0 && service.options.History != nil {
			receipt.err = service.options.History.Mutate(bounded, func(state *contracts.State) error {
				if state.ConversationID != receipt.conversation {
					return nil
				}
				for _, message := range state.Messages {
					if message != nil && message.Kind == "call" && message.CallID == call.ID && message.Provider == call.Provider {
						return nil
					}
				}
				seconds := max(0, math.Floor(float64(service.options.Now().UnixMilli())/1000-connected/1000+0.5))
				state.Messages = append(state.Messages, &contracts.ChatMessage{ID: service.options.NewID(), Role: contracts.RoleSystem, Kind: "call", Provider: call.Provider, CallID: call.ID, Seconds: contracts.Some(seconds), Text: "", Time: contracts.Some(float64(service.options.Now().UnixMilli())), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), Attachments: []contracts.Attachment{}, Reactions: []string{}})
				return nil
			})
		}
		var err error
		switch event.Reason {
		case CallEndUser, CallEndTool, CallEndConnectionLost:
			if service.options.ContinueVoiceTasks != nil {
				err = service.options.ContinueVoiceTasks(bounded, call.ID)
			}
		default:
			if service.options.CancelOwner != nil {
				err = service.options.CancelOwner(bounded, call.ID)
			}
		}
		if err != nil {
			receipt.err = ErrCallLifecycle
		}
	})
	if receipt.err != nil {
		return ErrCallLifecycle
	}
	return nil
}
