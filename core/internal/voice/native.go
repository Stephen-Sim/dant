package voice

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/google/uuid"
)

var ErrNativeUnknown = errors.New("native_voice_ownership_unconfirmed")
var ErrNativeStop = errors.New("native_voice_shutdown_unconfirmed")

func NewNative(ctx context.Context, options NativeOptions) (*Native, error) {
	if options.Worker == nil || options.Engine == nil || options.Store == nil {
		return nil, ErrCallInput
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = uuid.NewString
	}
	if options.Redact == nil {
		options.Redact = func(text string) string { return text }
	}
	if options.ConnectTimeout == 0 {
		options.ConnectTimeout = defaultConnectTimeout
	}
	if options.StopTimeout == 0 {
		options.StopTimeout = defaultMediaStopTimeout
	}
	if options.ContextTimeout == 0 {
		options.ContextTimeout = defaultContextTimeout
	}
	for _, limit := range []time.Duration{options.ConnectTimeout, options.StopTimeout, options.ContextTimeout} {
		if limit < minimumProviderTimeout || limit > maximumNativeTimeout {
			return nil, ErrCallInput
		}
	}
	return &Native{ctx: ctx, options: options, voices: NativeVoices(), intake: make(chan struct{}, 1), sessions: map[*nativeSession]bool{}}, nil
}

func (native *Native) changed() {
	if native.options.Changed != nil {
		native.options.Changed()
	}
}

func (native *Native) current(s *nativeSession, generation uint64) bool {
	native.mu.Lock()
	defer native.mu.Unlock()
	return native.session == s && s.generation == generation && !s.stopping && !s.closed && s.ctx.Err() == nil
}

func (native *Native) callLocked() *contracts.Call {
	if s := native.session; s != nil && !s.background {
		return &contracts.Call{ID: s.mediaID, Provider: "subscription", Status: s.status, Started: contracts.Some(float64(s.startedAt)), ConnectedAt: func() contracts.Optional[float64] {
			if s.connectedAt > 0 {
				return contracts.Some(float64(s.connectedAt))
			}
			return contracts.Null[float64]()
		}()}
	}
	return nil
}

func (native *Native) Call() *contracts.Call {
	native.mu.Lock()
	defer native.mu.Unlock()
	return native.callLocked()
}

func (native *Native) Snapshot() NativeState {
	native.mu.Lock()
	defer native.mu.Unlock()
	value := NativeState{Call: native.callLocked(), Model: NativeRealtimeModel}
	if native.lastError != nil {
		copy := *native.lastError
		value.Error = &copy
	}
	if s := native.session; s != nil {
		value.Voice = s.voice
		value.Background = s.background
		value.Unknown = s.unknown
	}
	return value
}

func (native *Native) ListVoices(ctx context.Context) (contracts.RawObject, error) {
	result, err := native.options.Worker.Request(ctx, "thread/realtime/listVoices", contracts.RawObject{})
	if err != nil {
		return nil, err
	}
	var voices []string
	if json.Unmarshal(objectField(result, "voices")["v3"], &voices) != nil || len(voices) == 0 || len(voices) > 256 {
		return nil, ErrVoiceConnection
	}
	unique := []string{}
	seen := map[string]bool{}
	for _, voice := range voices {
		if contracts.UTF16Length(voice) > 80 {
			return nil, ErrVoiceConnection
		}
		if !seen[voice] {
			seen[voice] = true
			unique = append(unique, voice)
		}
	}
	native.mu.Lock()
	native.voices = unique
	native.mu.Unlock()
	result["defaultV3"] = rawValue(DefaultNativeVoice)
	result["defaultNative"] = rawValue(DefaultNativeVoice)
	return result, nil
}

func (native *Native) Start(ctx context.Context, input NativeStart) (NativeStartResult, error) {
	if !validSDP(input.SDP) {
		return NativeStartResult{}, ErrCallInput
	}
	if input.CallID == "" {
		input.CallID = native.options.NewID()
	}
	if !captionID(input.CallID) {
		return NativeStartResult{}, ErrCallInput
	}
	native.mu.Lock()
	if native.disposed {
		native.mu.Unlock()
		return NativeStartResult{}, ErrVoiceClosed
	}
	existing := native.session
	if existing != nil && !existing.background {
		native.mu.Unlock()
		return NativeStartResult{}, ErrVoiceBusy
	}
	if existing != nil && existing.unknown {
		native.mu.Unlock()
		return NativeStartResult{}, ErrNativeUnknown
	}
	allowed := false
	for _, voice := range native.voices {
		if voice == input.Voice {
			allowed = true
		}
	}
	if !allowed {
		input.Voice = DefaultNativeVoice
	}
	native.mu.Unlock()
	reservation, err := native.options.Engine.ReserveCallStart(ctx, input.CallID, "subscription")
	if err != nil {
		return NativeStartResult{}, err
	}
	defer native.options.Engine.ReleaseCallStart(reservation)

	native.mu.Lock()
	if native.disposed {
		native.mu.Unlock()
		return NativeStartResult{}, ErrVoiceClosed
	}
	if native.session != existing {
		native.mu.Unlock()
		return NativeStartResult{}, ErrVoiceBusy
	}
	s := existing
	if s == nil {
		if len(native.sessions) >= nativeSessionLimit {
			native.mu.Unlock()
			return NativeStartResult{}, ErrVoiceBusy
		}
		owned, cancel := context.WithCancel(native.ctx)
		s = &nativeSession{
			id: input.CallID, ctx: owned, cancel: cancel,
			turns:        map[string]*nativeTurn{},
			handoffs:     map[string]*nativeHandoff{},
			finished:     map[string]bool{},
			pendingTurns: map[string][]runtime.Event{},
			callInputs:   map[string]*nativeInput{},
			workEvents:   make(chan nativeQueuedEvent, nativeEventLimit),
			mediaEvents:  make(chan nativeQueuedEvent, nativeEventLimit),
			joined:       make(chan struct{}),
		}
		native.session = s
		native.sessions[s] = true
		s.workers.Add(2)
		go native.eventLoop(s, false)
		go native.eventLoop(s, true)
		go func() {
			s.workers.Wait()
			close(s.joined)
			native.mu.Lock()
			delete(native.sessions, s)
			native.mu.Unlock()
		}()
	} else {
		s.retired.add(s.realtimeID)
		s.generation++
		s.reconnecting = true
	}
	s.mediaID = input.CallID
	s.voice = input.Voice
	s.status = contracts.VoiceCallStatusConnecting
	s.startedAt = native.options.Now().UnixMilli()
	s.connectedAt = 0
	s.closed = false
	s.stopping = false
	s.background = false
	s.started = false
	s.startAccepted = false
	s.startSubmitted = false
	s.answer = ""
	s.realtimeID = ""
	s.ready = make(chan struct{})
	s.readyOnce = sync.Once{}
	s.closedSignal = make(chan struct{})
	s.closedOnce = sync.Once{}
	s.failure = make(chan error, 1)
	s.subtitles = NewSubtitles(input.CallID, "subscription", native.options.Redact)
	generation := s.generation
	native.lastError = nil
	native.mu.Unlock()
	native.changed()
	fail := func(cause error) (NativeStartResult, error) {
		native.mu.Lock()
		remove := false
		if native.session == s && s.generation == generation {
			code := ErrVoiceConnection.Error()
			native.lastError = &code
			s.unknown = s.startSubmitted
			s.status = contracts.VoiceCallStatusStopUnconfirmed
			s.background = false
			s.reconnecting = false
			remove = !s.startSubmitted
		}
		native.mu.Unlock()
		if remove {
			native.finish(s)
		}
		native.changed()
		return NativeStartResult{}, cause
	}
	bounded, cancel := context.WithTimeout(ctx, native.options.ConnectTimeout)
	defer cancel()
	thread, err := native.options.Engine.Thread(bounded)
	if err != nil {
		return fail(err)
	}
	if !native.options.Engine.CallStartCurrent(reservation) || !native.current(s, generation) {
		return fail(ErrVoiceCancelled)
	}
	native.mu.Lock()
	s.threadID = thread
	s.startSubmitted = true
	native.mu.Unlock()
	prompt := voiceInstruction("nativeVoicePrompt") + "\n\n" + BuildMemoryContext(input.Memory)
	_, err = native.options.Worker.Request(bounded, "thread/realtime/start", object(map[string]any{
		"threadId":                        thread,
		"outputModality":                  "audio",
		"version":                         "v3",
		"model":                           NativeRealtimeModel,
		"voice":                           input.Voice,
		"transport":                       map[string]any{"type": "webrtc", "sdp": input.SDP},
		"voiceSessionId":                  input.CallID,
		"clientManagedHandoffs":           false,
		"flushTranscriptTailOnSessionEnd": true,
		"prompt":                          prompt,
		"realtimeStartInstructions": strings.Join([]string{
			memory.IdentityInstructions,
			voiceInstruction("callReferenceInstructions"),
			voiceInstruction("backendCallInstructions"),
		}, "\n\n"),
		"realtimeEndInstructions": "The voice media has ended. Continue work that was already accepted. Report verified results, problems, or requests for user input in the existing chat. Do not replay speech or start new unrequested tasks.",
	}))
	if err != nil {
		var rejected *runtime.OperationError
		if errors.As(err, &rejected) && !rejected.UnknownOutcome {
			native.mu.Lock()
			if !s.started && s.answer == "" {
				s.startSubmitted = false
			}
			native.mu.Unlock()
		}
		return fail(err)
	}
	native.mu.Lock()
	s.startAccepted = true
	ready, failure := s.ready, s.failure
	native.mu.Unlock()
	select {
	case <-ready:
	case err = <-failure:
		return fail(err)
	case <-bounded.Done():
		return fail(ErrVoiceConnection)
	}
	if !native.options.Engine.CallStartCurrent(reservation) || !native.current(s, generation) {
		return fail(ErrNativeUnknown)
	}
	native.mu.Lock()
	s.status = contracts.VoiceCallStatusNegotiating
	s.reconnecting = false
	answer := s.answer
	native.mu.Unlock()
	native.changed()
	return NativeStartResult{answer, input.CallID, "subscription"}, nil
}

func (native *Native) ConfirmConnected(callID string) error {
	native.mu.Lock()
	if s := native.session; s != nil && s.mediaID == callID && s.started && s.startAccepted && !s.closed && !s.stopping && !s.unknown {
		s.status = contracts.VoiceCallStatusConnected
		if s.connectedAt == 0 {
			s.connectedAt = native.options.Now().UnixMilli()
		}
		native.mu.Unlock()
		native.changed()
		return nil
	}
	native.mu.Unlock()
	return ErrVoiceCancelled
}
