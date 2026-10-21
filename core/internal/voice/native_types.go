package voice

import (
	"context"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const NativeRealtimeModel = "gpt-live-1-codex"
const DefaultNativeVoice = "ember"
const nativeEventLimit = 128
const nativeEventByteLimit = 1024 * 1024
const nativeTurnLimit = 128
const nativeSessionLimit = 16

var nativeVoices = []string{"juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove", "aube", "bubbie", "haetsal", "hanul", "himari", "leher", "miko", "neer", "porto", "rindo", "rio", "rivage", "selva", "sonna", "tinta", "viola"}

func NativeVoices() []string { return append([]string{}, nativeVoices...) }

type NativeEngine interface {
	Thread(context.Context) (string, error)
	Snapshot() work.Snapshot
	ReserveCallStart(context.Context, string, string) (work.CallStartReservation, error)
	CallStartCurrent(work.CallStartReservation) bool
	ReleaseCallStart(work.CallStartReservation)
	AdoptNativeTurn(context.Context, work.NativeTurnInput) (work.ToolContext, error)
	HandleNativeEvent(context.Context, work.ToolContext, runtime.Event) error
	NativeTaskSnapshot(work.ToolContext) *contracts.ActiveExecution
	ContinueNativeWork(work.ToolContext) error
	PauseNativeWork(context.Context, work.ToolContext) error
}

type NativePersistence interface {
	Snapshot() contracts.State
	Add(context.Context, *contracts.ChatMessage) (*contracts.ChatMessage, error)
	Update(context.Context, string, contracts.MessagePatch) (*contracts.ChatMessage, error)
}

type NativeOptions struct {
	Worker work.Worker
	Engine NativeEngine
	Store  NativePersistence

	Now    func() time.Time
	NewID  func() string
	Redact Redactor

	Subtitle func(Caption)
	Changed  func()
	Notice   func(string)

	MemoryReference   func(context.Context, *contracts.ChatMessage) (string, error)
	RememberCallInput func(context.Context, *contracts.ChatMessage, string) error

	ConnectTimeout time.Duration
	StopTimeout    time.Duration
	ContextTimeout time.Duration
}

type NativeStart struct{ SDP, Voice, CallID, Memory string }
type NativeStartResult struct {
	SDP      string `json:"sdp"`
	CallID   string `json:"callId"`
	Provider string `json:"provider"`
}

type NativeState struct {
	Call       *contracts.Call `json:"call"`
	Error      *string         `json:"error"`
	Model      string          `json:"model"`
	Voice      string          `json:"voice"`
	Background bool            `json:"background"`
	Unknown    bool            `json:"unknown"`
}

type nativeHandoff struct {
	itemID, turnID string
	idleConfirmed  bool
}

type nativeTurn struct {
	owner work.ToolContext
	done  bool
}

type nativeQueuedEvent struct {
	event      runtime.Event
	generation uint64
	bytes      int
}

type nativeInput struct {
	epoch, generation   uint64
	dispatched, settled bool
	done                chan struct{}
	result              NativeMessageResult
	err                 error
	isCurrent           func() bool
}

type NativeMessageResult struct {
	Message        *contracts.ChatMessage     `json:"message"`
	CallID         string                     `json:"callId"`
	Submission     contracts.SubmissionStatus `json:"submission"`
	Duplicate      bool                       `json:"duplicate,omitempty"`
	UnknownOutcome bool                       `json:"unknownOutcome,omitempty"`
	VoiceContext   *ContextResult             `json:"voiceContext,omitempty"`
}

type NativeMessage struct {
	ClientMessageID, Text, CallID string
	ReplyTo                       *string
}

type nativeContinuation struct {
	admission                       work.ContinuationAdmission
	turnID                          string
	conflict, checked, acknowledged bool
	retained                        []runtime.Event
}

type nativeSession struct {
	id         string
	mediaID    string
	voice      string
	status     contracts.VoiceCallStatus
	threadID   string
	realtimeID string
	answer     string

	startedAt   int64
	connectedAt int64
	generation  uint64
	workEpoch   uint64

	started        bool
	startSubmitted bool
	startAccepted  bool
	closed         bool
	stopping       bool
	background     bool
	unknown        bool
	pausing        bool
	reconnecting   bool

	ctx          context.Context
	cancel       context.CancelFunc
	ready        chan struct{}
	readyOnce    sync.Once
	closedSignal chan struct{}
	closedOnce   sync.Once
	failure      chan error

	retired      nativeRetiredIDs
	subtitles    *Subtitles
	turns        map[string]*nativeTurn
	handoffs     map[string]*nativeHandoff
	handoffOrder []string
	finished     map[string]bool
	pendingTurns map[string][]runtime.Event
	pendingOrder []string
	pendingBytes int

	callInputs   map[string]*nativeInput
	contextQueue *ContextQueue
	continuation *nativeContinuation

	workEvents   chan nativeQueuedEvent
	mediaEvents  chan nativeQueuedEvent
	queuedEvents int
	queuedBytes  int
	workers      sync.WaitGroup
	joined       chan struct{}
	stopMu       sync.Mutex
}

type Native struct {
	mu        sync.Mutex
	intake    chan struct{}
	ctx       context.Context
	options   NativeOptions
	session   *nativeSession
	sessions  map[*nativeSession]bool
	voices    []string
	lastError *string
	disposed  bool
	ended     EndedHandler
}
