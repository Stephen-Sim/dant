package voice

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
	"github.com/google/uuid"
)

type ServiceOptions struct {
	API                *API
	Native             *Native
	Settings           func() contracts.Settings
	Memory             func(context.Context) (string, error)
	RememberCallInput  func(context.Context, *contracts.ChatMessage, string) error
	Now                func() time.Time
	NewID              func() string
	Reservations       CallReservations
	History            ReferencePersistence
	ContinueVoiceTasks func(context.Context, string) error
	CancelOwner        func(context.Context, string) error
}

type CallReservations interface {
	ReserveCallStart(context.Context, string, string) (work.CallStartReservation, error)
	CallStartCurrent(work.CallStartReservation) bool
	ReleaseCallStart(work.CallStartReservation)
}

type CallStartRequest struct {
	SDP      string  `json:"sdp"`
	Provider string  `json:"provider"`
	CallID   string  `json:"callId,omitempty"`
	Voice    string  `json:"voice,omitempty"`
	Memory   string  `json:"memory,omitempty"`
	Context  *string `json:"context,omitempty"`
	APIKey   string  `json:"-"`
}

type CallStartResult struct {
	SDP      string `json:"sdp"`
	CallID   string `json:"callId"`
	Provider string `json:"provider"`
}

type Service struct {
	mu             sync.Mutex
	options        ServiceOptions
	starting       bool
	apiConnected   string
	apiConnectedAt int64
	receipts       map[string]*callReceipt
}

func NewService(options ServiceOptions) *Service {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = uuid.NewString
	}
	service := &Service{options: options, receipts: map[string]*callReceipt{}}
	if options.API != nil {
		options.API.setEnded(service.ended)
	}
	if options.Native != nil {
		options.Native.setEnded(service.ended)
	}
	return service
}

// AttachNative completes the assembly cycle after Engine receives this service
// as its call capability. It never swaps a provider that has accepted work.
func (service *Service) AttachNative(native *Native) error {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.options.Native != nil || service.starting || native == nil {
		return ErrVoiceBusy
	}
	service.options.Native = native
	native.setEnded(service.ended)
	return nil
}

func (service *Service) AttachReservations(reservations CallReservations) error {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.options.Reservations != nil || service.starting || reservations == nil {
		return ErrVoiceBusy
	}
	service.options.Reservations = reservations
	return nil
}

func (service *Service) providers() (*API, *Native) {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.options.API, service.options.Native
}

func (service *Service) Snapshot() *contracts.Call {
	api, native := service.providers()
	if native != nil {
		if call := native.Call(); call != nil {
			return call
		}
	}
	if api == nil {
		return nil
	}
	state := api.Snapshot()
	if state.Call == nil {
		return nil
	}
	call := state.Call
	status := call.Status
	if status == contracts.VoiceCallStatusActive {
		status = contracts.VoiceCallStatusNegotiating
	}
	result := &contracts.Call{ID: call.CallID, Provider: "api", Status: status, Started: contracts.Some(float64(call.Started)), ConnectedAt: contracts.Null[float64]()}
	service.mu.Lock()
	if service.apiConnected == call.CallID {
		result.Status = contracts.VoiceCallStatusConnected
		result.ConnectedAt = contracts.Some(float64(service.apiConnectedAt))
	}
	service.mu.Unlock()
	return result
}

func (service *Service) StartCall(ctx context.Context, input CallStartRequest) (CallStartResult, error) {
	if input.Provider == "" {
		input.Provider = "subscription"
	}
	if input.Provider != "subscription" && input.Provider != "api" {
		return CallStartResult{}, ErrCallInput
	}
	service.mu.Lock()
	if service.starting {
		service.mu.Unlock()
		return CallStartResult{}, ErrVoiceBusy
	}
	service.starting = true
	service.mu.Unlock()
	defer func() { service.mu.Lock(); service.starting = false; service.mu.Unlock() }()
	if service.Snapshot() != nil {
		return CallStartResult{}, ErrVoiceBusy
	}

	if input.CallID == "" {
		input.CallID = service.options.NewID()
	}
	if !captionID(input.CallID) {
		return CallStartResult{}, ErrCallInput
	}
	var reservation work.CallStartReservation
	if input.Provider == "api" {
		if service.options.Reservations == nil {
			return CallStartResult{}, ErrVoiceConnection
		}
		var err error
		reservation, err = service.options.Reservations.ReserveCallStart(ctx, input.CallID, input.Provider)
		if err != nil {
			return CallStartResult{}, err
		}
		defer service.options.Reservations.ReleaseCallStart(reservation)
	}

	settings := contracts.Settings{}
	if service.options.Settings != nil {
		settings = service.options.Settings()
	}
	if input.Memory == "" && service.options.Memory != nil {
		var err error
		input.Memory, err = service.options.Memory(ctx)
		if err != nil {
			return CallStartResult{}, ErrVoiceContext
		}
	}
	api, native := service.providers()
	if err := service.rememberCall(input); err != nil {
		return CallStartResult{}, err
	}
	if input.Provider == "api" {
		if api == nil {
			return CallStartResult{}, ErrVoiceConnection
		}
		if !service.options.Reservations.CallStartCurrent(reservation) {
			return CallStartResult{}, ErrVoiceCancelled
		}
		if input.Voice == "" {
			input.Voice = settings.APIVoice
			if input.Voice == "" {
				input.Voice = "marin"
			}
		}
		result, err := api.Start(ctx, APIStart{SDP: input.SDP, Voice: input.Voice, Memory: input.Memory, Context: input.Context, CallID: input.CallID, Key: input.APIKey})
		if err != nil {
			if service.Snapshot() == nil {
				_ = service.ended(ctx, EndedEvent{CallID: input.CallID, Provider: input.Provider, Reason: CallEndStartFailed})
			}
			return CallStartResult{}, err
		}
		if !service.options.Reservations.CallStartCurrent(reservation) {
			bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if err = api.Stop(bounded, "call-start-changed"); err != nil {
				return CallStartResult{}, err
			}
			return CallStartResult{}, ErrVoiceCancelled
		}
		return CallStartResult{result.SDP, input.CallID, "api"}, nil
	}
	if native == nil {
		return CallStartResult{}, ErrVoiceConnection
	}
	if input.Voice == "" {
		input.Voice = settings.NativeVoice
		if input.Voice == "" {
			input.Voice = DefaultNativeVoice
		}
	}
	result, err := native.Start(ctx, NativeStart{input.SDP, input.Voice, input.CallID, input.Memory})
	if err != nil {
		if service.Snapshot() == nil {
			_ = service.ended(ctx, EndedEvent{CallID: input.CallID, Provider: input.Provider, Reason: CallEndStartFailed})
		}
		return CallStartResult{}, err
	}
	return CallStartResult{result.SDP, result.CallID, result.Provider}, nil
}

func (service *Service) Start(ctx context.Context, params contracts.RawObject) (contracts.Call, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return contracts.Call{}, ErrCallInput
	}
	var input CallStartRequest
	if json.Unmarshal(raw, &input) != nil {
		return contracts.Call{}, ErrCallInput
	}
	if _, err = service.StartCall(ctx, input); err != nil {
		return contracts.Call{}, err
	}
	call := service.Snapshot()
	if call == nil {
		return contracts.Call{}, ErrVoiceConnection
	}
	return *call, nil
}

func (service *Service) ConfirmConnected(callID string) (*contracts.Call, error) {
	call := service.Snapshot()
	if call == nil || call.ID != callID {
		return nil, ErrVoiceCancelled
	}
	_, native := service.providers()
	if call.Provider == "subscription" {
		if err := native.ConfirmConnected(callID); err != nil {
			return nil, err
		}
	} else {
		service.mu.Lock()
		if service.apiConnected != callID {
			service.apiConnected = callID
			service.apiConnectedAt = service.options.Now().UnixMilli()
		}
		if receipt := service.receipts[callID]; receipt != nil {
			receipt.call.ConnectedAt = contracts.Some(float64(service.apiConnectedAt))
			receipt.call.Status = contracts.VoiceCallStatusConnected
		}
		service.mu.Unlock()
	}
	connected := service.Snapshot()
	service.mu.Lock()
	if receipt := service.receipts[callID]; receipt != nil && connected != nil {
		receipt.call = *connected
	}
	service.mu.Unlock()
	return connected, nil
}

func (service *Service) Stop(ctx context.Context, callID string) error {
	call := service.Snapshot()
	if call == nil {
		return nil
	}
	if call.ID != callID {
		return ErrVoiceCancelled
	}
	api, native := service.providers()
	if call.Provider == "subscription" {
		return native.Stop(ctx, callID)
	}
	err := api.Stop(ctx, "user")
	service.mu.Lock()
	if service.apiConnected == callID {
		service.apiConnected = ""
		service.apiConnectedAt = 0
	}
	service.mu.Unlock()
	return err
}

func (service *Service) OwnsEvent(event runtime.Event) bool {
	_, native := service.providers()
	return native != nil && native.OwnsEvent(event)
}

func (service *Service) HandleEvent(ctx context.Context, event runtime.Event) error {
	_, native := service.providers()
	if native == nil {
		return nil
	}
	return native.HandleEvent(ctx, event)
}

func (service *Service) PauseWork(ctx context.Context) error {
	_, native := service.providers()
	if native == nil {
		return nil
	}
	return native.PauseWork(ctx)
}

func (service *Service) PendingWork() bool {
	_, native := service.providers()
	return native != nil && native.PendingWork()
}

func (service *Service) CanContinueWhileIdle(owner work.ContinuationOwner) bool {
	_, native := service.providers()
	return native == nil || native.CanContinueWhileIdle(owner)
}

func (service *Service) BeginContinuationAdmission(owner work.ContinuationOwner) (work.ContinuationAdmission, error) {
	_, native := service.providers()
	if native == nil {
		return work.ContinuationAdmission{Owner: owner}, nil
	}
	return native.BeginContinuationAdmission(owner)
}

func (service *Service) ConfirmContinuationAdmission(admission work.ContinuationAdmission, turn string) error {
	_, native := service.providers()
	if native == nil {
		return nil
	}
	return native.ConfirmContinuationAdmission(admission, turn)
}

func (service *Service) ReplayContinuationEvents(ctx context.Context, admission work.ContinuationAdmission, events []runtime.Event, turn string, notSubmitted bool) ([]runtime.Event, bool, error) {
	_, native := service.providers()
	if native == nil {
		return events, false, nil
	}
	return native.ReplayContinuationEvents(ctx, admission, events, turn, notSubmitted)
}

func (service *Service) FinishContinuationAdmission(admission work.ContinuationAdmission) {
	_, native := service.providers()
	if native != nil {
		native.FinishContinuationAdmission(admission)
	}
}

func (service *Service) Close(ctx context.Context) error {
	api, native := service.providers()
	var first error
	if api != nil {
		first = api.Close(ctx)
	}
	if native != nil {
		if err := native.Close(ctx); first == nil {
			first = err
		}
	}
	return first
}

var _ work.CallService = (*Service)(nil)
var _ work.ContinuationCalls = (*Service)(nil)
