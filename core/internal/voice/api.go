package voice

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/google/uuid"
)

func NewAPI(ctx context.Context, options APIOptions) (*API, error) {
	if options.GetKey == nil || options.RunTask == nil || options.Tool == nil {
		return nil, ErrCallInput
	}
	if options.Model == "" {
		options.Model = DefaultVoiceModel
	}
	if options.HTTP == nil {
		options.HTTP = defaultVoiceHTTP()
	}
	if options.Dial == nil {
		options.Dial = dialVoice
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = uuid.NewString
	}
	if options.ConnectTimeout == 0 {
		options.ConnectTimeout = 15 * time.Second
	}
	if options.RequestTimeout == 0 {
		options.RequestTimeout = 30 * time.Second
	}
	if options.HangupTimeout == 0 {
		options.HangupTimeout = 10 * time.Second
	}
	if options.ContextTimeout == 0 {
		options.ContextTimeout = 5 * time.Second
	}
	for _, limit := range []time.Duration{options.ConnectTimeout, options.RequestTimeout, options.HangupTimeout, options.ContextTimeout} {
		if limit < time.Millisecond || limit > 5*time.Minute {
			return nil, ErrCallInput
		}
	}
	if options.Redact == nil {
		options.Redact = func(text string, secrets []string) string { return security.RedactCredentialText(text, secrets, true) }
	}
	return &API{ctx: ctx, options: options}, nil
}

func (api *API) changed() {
	if api.options.Changed != nil {
		api.options.Changed()
	}
}

func (api *API) notice(code string) {
	if api.options.Notice != nil {
		api.options.Notice(code)
	}
}

func (api *API) current(s *apiSession) bool {
	api.mu.Lock()
	defer api.mu.Unlock()
	return api.session == s && !s.stopping && !s.closed && s.ctx.Err() == nil
}

func (api *API) stateLocked() APIState {
	value := APIState{Error: api.lastError}
	if api.lastError != nil {
		copy := *api.lastError
		value.Error = &copy
	}
	if s := api.session; s != nil {
		value.Call = &APICall{s.callID, s.started, s.status, "openai-realtime", api.options.Model, s.voice}
		value.InputUnconfirmed = s.inputUnknown
	}
	return value
}

func (api *API) Snapshot() APIState {
	api.mu.Lock()
	defer api.mu.Unlock()
	return api.stateLocked()
}
func (api *API) baseInstructions(s *apiSession, memory string) string {
	return strings.Join([]string{voiceInstruction("api"), voiceInstruction("taskCancel"), voiceInstruction("schedules"), BuildMemoryContext(memory), s.baseReference}, "\n\n")
}

func (api *API) Start(ctx context.Context, input APIStart) (APIStartResult, error) {
	if !validSDP(input.SDP) {
		return APIStartResult{}, ErrCallInput
	}
	if input.Voice == "" {
		input.Voice = "marin"
	}
	if !validAPIVoice(input.Voice) {
		return APIStartResult{}, ErrCallInput
	}
	if input.CallID == "" {
		input.CallID = api.options.NewID()
	}
	if !captionID(input.CallID) {
		return APIStartResult{}, ErrCallInput
	}
	api.mu.Lock()
	if api.disposed {
		api.mu.Unlock()
		return APIStartResult{}, ErrVoiceClosed
	}
	if api.session != nil {
		api.mu.Unlock()
		return APIStartResult{}, ErrVoiceBusy
	}
	owned, cancel := context.WithCancel(api.ctx)
	s := &apiSession{
		callID: input.CallID, voice: input.Voice,
		status:  contracts.VoiceCallStatusConnecting,
		started: api.options.Now().UnixMilli(),
		ctx:     owned, cancel: cancel,

		contextEntries: map[string]string{},
		messages:       map[string]*apiInput{},
		messageGate:    make(chan struct{}, 1),
		tools:          map[string]bool{},
		toolQueue:      make(chan apiTool, 32),

		conversation:       map[string]*conversationNode{},
		conversationQueue:  make(chan ConversationItem, 256),
		conversationNotify: make(chan struct{}, 1),
		cleanupDone:        make(chan struct{}),
	}
	s.subtitles = NewSubtitles(s.callID, "api", func(text string) string { return api.redact(s, text) })
	api.session = s
	api.lastError = nil
	api.mu.Unlock()
	api.changed()
	fail := func(err error) (APIStartResult, error) {
		api.mu.Lock()
		code := err.Error()
		if api.session == s {
			api.lastError = &code
		}
		api.mu.Unlock()
		_ = api.cleanup(context.Background(), s, "start-failed")
		return APIStartResult{}, err
	}
	key := input.Key
	var err error
	if key == "" {
		key, err = api.options.GetKey(ctx)
		if err != nil {
			return fail(ErrVoiceKey)
		}
	}
	key, err = security.ValidateAPIKey(key)
	if err != nil {
		return fail(ErrVoiceKey)
	}
	if !api.current(s) {
		return fail(ErrVoiceCancelled)
	}
	reference := ""
	if input.Context != nil {
		reference = *input.Context
	} else if api.options.Context != nil {
		reference, err = api.options.Context(ctx, false)
		if err != nil {
			return fail(ErrVoiceContext)
		}
	}
	api.mu.Lock()
	s.key = key
	s.baseMemory = input.Memory
	if reference != "" {
		s.baseReference = "Chat context:\n" + reference
	}
	s.baseInstructions = api.baseInstructions(s, input.Memory)
	api.mu.Unlock()
	requestCtx, requestCancel := context.WithTimeout(ctx, api.options.RequestTimeout)
	stop := context.AfterFunc(s.ctx, requestCancel)
	answer, err := api.createCall(requestCtx, s, input.SDP)
	stop()
	requestCancel()
	if err != nil {
		return fail(err)
	}
	if !api.current(s) {
		return fail(ErrVoiceCancelled)
	}
	connectCtx, connectCancel := context.WithTimeout(ctx, api.options.ConnectTimeout)
	stop = context.AfterFunc(s.ctx, connectCancel)
	api.mu.Lock()
	remote := s.id
	api.mu.Unlock()
	socket, err := api.options.Dial(connectCtx, "wss://api.openai.com/v1/realtime?call_id="+url.QueryEscape(remote), key)
	stop()
	connectCancel()
	if err != nil {
		return fail(ErrVoiceConnection)
	}
	api.mu.Lock()
	if api.session != s || s.closed || s.stopping {
		api.mu.Unlock()
		socket.Close()
		return fail(ErrVoiceCancelled)
	}
	s.socket = socket
	s.ready = true
	s.status = contracts.VoiceCallStatusActive
	s.workers.Add(3)
	api.mu.Unlock()
	go api.readLoop(s)
	go api.toolLoop(s)
	go api.conversationLoop(s)
	api.changed()
	return APIStartResult{answer}, nil
}

func (api *API) redact(s *apiSession, text string) string {
	api.mu.Lock()
	key := s.key
	api.mu.Unlock()
	secrets := []string{}
	if key != "" {
		secrets = append(secrets, key)
	}
	return api.options.Redact(text, secrets)
}

func (api *API) Stop(ctx context.Context, reason string) error {
	api.mu.Lock()
	s := api.session
	api.mu.Unlock()
	if s == nil {
		return nil
	}
	if reason != "user" && reason != "tool" && reason != "shutdown" {
		reason = "user"
	}
	return api.cleanup(ctx, s, reason)
}

func (api *API) Close(ctx context.Context) error {
	api.mu.Lock()
	api.disposed = true
	api.mu.Unlock()
	return api.Stop(ctx, "shutdown")
}

func (api *API) cleanup(ctx context.Context, s *apiSession, reason string) error {
	s.cleanupOnce.Do(func() { go api.finishSession(s, reason) })
	select {
	case <-s.cleanupDone:
		return s.cleanupErr
	case <-ctx.Done():
		return ErrVoiceHangup
	}
}

func (api *API) finishSession(s *apiSession, reason string) {
	defer close(s.cleanupDone)
	api.mu.Lock()
	s.stopping = true
	s.status = contracts.VoiceCallStatusStopping
	queue := s.contextQueue
	if ack := s.contextAck; ack != nil {
		s.contextAck = nil
		select {
		case ack.done <- ErrVoiceCancelled:
		default:
		}
	}
	if ack := s.inputAck; ack != nil {
		s.inputAck = nil
		select {
		case ack.ack <- ErrVoiceCancelled:
		default:
		}
	}
	api.mu.Unlock()
	if value := s.subtitles.Clear(); value != nil && api.options.Subtitle != nil {
		api.options.Subtitle(*value)
	}
	api.changed()
	bounded, cancel := context.WithTimeout(context.WithoutCancel(api.ctx), api.options.HangupTimeout)
	defer cancel()
	if queue != nil {
		if err := queue.Close(bounded); err != nil {
			s.cleanupErr = ErrVoiceContext
		}
	}
	if err := api.drainConversation(bounded, s); err != nil {
		api.notice("voice_final_context_unconfirmed")
	}
	if err := api.hangup(s); err != nil {
		s.cleanupErr = err
	}
	api.mu.Lock()
	s.closed = true
	s.cancel()
	socket := s.socket
	api.mu.Unlock()
	if socket != nil {
		_ = socket.Close()
	}
	joined := make(chan struct{})
	go func() { s.workers.Wait(); close(joined) }()
	select {
	case <-joined:
	case <-bounded.Done():
		s.cleanupErr = ErrVoiceHangup
	}
	api.mu.Lock()
	s.key = ""
	if api.session == s {
		api.session = nil
	}
	if s.cleanupErr != nil {
		code := s.cleanupErr.Error()
		api.lastError = &code
	}
	ended := api.ended
	api.mu.Unlock()
	if ended != nil {
		if err := ended(bounded, EndedEvent{CallID: s.callID, Provider: "api", Reason: CallEndReason(reason)}); err != nil && s.cleanupErr == nil {
			s.cleanupErr = ErrCallLifecycle
		}
	}
	api.changed()
}

func (api *API) fail(s *apiSession, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	api.mu.Lock()
	if api.session != s || s.closed || s.stopping {
		api.mu.Unlock()
		return
	}
	code := err.Error()
	api.lastError = &code
	api.mu.Unlock()
	api.notice(code)
	s.cleanupOnce.Do(func() { go api.finishSession(s, "connection-lost") })
}
