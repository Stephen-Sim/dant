package voice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const DefaultVoiceModel = "gpt-realtime-2.1"
const voiceAPI = "https://api.openai.com/v1/realtime/calls"
const maxVoiceEventBytes = 8 * 1024 * 1024
const maxAPIConversationItems = 4096
const maxAPITools = 1000

var apiVoices = []string{"marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"}

func APIVoices() []string { return append([]string{}, apiVoices...) }

var ErrVoiceClosed = errors.New("voice_provider_closed")
var ErrVoiceBusy = errors.New("voice_call_active")
var ErrVoiceCancelled = errors.New("voice_call_cancelled")
var ErrVoiceConnection = errors.New("voice_connection_failed")
var ErrVoiceHangup = errors.New("voice_hangup_unconfirmed")
var ErrVoiceKey = errors.New("voice_api_key_required")
var ErrVoiceContext = errors.New("voice_context_unconfirmed")

type VoiceInputError struct {
	Code           string
	Submission     contracts.SubmissionStatus
	UnknownOutcome bool
}

func (err *VoiceInputError) Error() string { return err.Code }

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type VoiceSocket interface {
	Read(context.Context) ([]byte, error)
	Write(context.Context, []byte) error
	Close() error
}

type VoiceDial func(context.Context, string, string) (VoiceSocket, error)
type ConversationItem struct {
	CallID         string                     `json:"callId"`
	ItemID         string                     `json:"itemId"`
	PreviousItemID contracts.Optional[string] `json:"previousItemId,omitzero"`
	Role           contracts.Role             `json:"role"`
	Text           string                     `json:"text"`
}

type APIOptions struct {
	GetKey  func(context.Context) (string, error)
	RunTask func(context.Context, string, work.ToolContext) (json.RawMessage, error)
	Tool    func(context.Context, string, contracts.RawObject, work.ToolContext) (json.RawMessage, error)

	Context            func(context.Context, bool) (string, error)
	OnConversationItem func(context.Context, ConversationItem) error
	Redact             func(string, []string) string

	Subtitle func(Caption)
	Usage    func(contracts.RawObject)
	Changed  func()
	Notice   func(string)

	HTTP  HTTPDoer
	Dial  VoiceDial
	Model string
	Now   func() time.Time
	NewID func() string

	ConnectTimeout time.Duration
	RequestTimeout time.Duration
	HangupTimeout  time.Duration
	ContextTimeout time.Duration
}

type APIStart struct {
	SDP     string  `json:"sdp"`
	Voice   string  `json:"voice"`
	Memory  string  `json:"memory"`
	Context *string `json:"context,omitempty"`
	CallID  string  `json:"callId,omitempty"`
	Key     string  `json:"-"`
}

type APIStartResult struct {
	SDP string `json:"sdp"`
}

type APICall struct {
	CallID   string                    `json:"callId"`
	Started  int64                     `json:"started"`
	Status   contracts.VoiceCallStatus `json:"status"`
	Provider string                    `json:"provider"`
	Model    string                    `json:"model"`
	Voice    string                    `json:"voice"`
}

type APIState struct {
	Call             *APICall `json:"call"`
	Error            *string  `json:"error"`
	InputUnconfirmed bool     `json:"inputUnconfirmed"`
}

type InputResult struct {
	MessageID   string                      `json:"messageId"`
	CallID      string                      `json:"callId"`
	Status      contracts.LiveContextStatus `json:"status"`
	Submission  contracts.SubmissionStatus  `json:"submission"`
	ConfirmedAt *int64                      `json:"confirmedAt,omitempty"`
}

type apiInput struct {
	messageID   string
	text        string
	inputText   string
	itemID      string
	eventID     string
	submission  contracts.SubmissionStatus
	confirmedAt *int64
	done        chan struct{}
	result      InputResult
	err         error
	ack         chan error
}

type apiContextAck struct {
	id, instructions string
	entries          map[string]string
	order            []string
	memory, base     string
	done             chan error
	sent             bool
}

type conversationNode struct {
	id, state, role, text      string
	known, inputAudio, emitted bool
	previous                   contracts.Optional[string]
}

type apiTool struct {
	id, name  string
	arguments json.RawMessage
}

type apiSession struct {
	callID  string
	id      string
	key     string
	voice   string
	status  contracts.VoiceCallStatus
	started int64

	ctx            context.Context
	cancel         context.CancelFunc
	ready          bool
	closed         bool
	stopping       bool
	activeResponse bool
	needsResponse  bool
	inputUnknown   bool
	socket         VoiceSocket
	subtitles      *Subtitles

	baseMemory       string
	baseReference    string
	baseInstructions string
	contextEntries   map[string]string
	contextOrder     []string
	contextQueue     *ContextQueue
	contextAck       *apiContextAck

	messages     map[string]*apiInput
	messageGate  chan struct{}
	inputAck     *apiInput
	tools        map[string]bool
	pendingTools int
	toolQueue    chan apiTool

	conversation        map[string]*conversationNode
	conversationOrder   []string
	conversationQueue   chan ConversationItem
	conversationPending int
	conversationError   bool
	conversationNotify  chan struct{}

	workers     sync.WaitGroup
	cleanupOnce sync.Once
	cleanupDone chan struct{}
	cleanupErr  error
}

type API struct {
	mu      sync.Mutex
	ctx     context.Context
	options APIOptions

	// session is live media; owned survives its ended callback and retains an
	// unconfirmed cleanup result so Close cannot forget or replay that owner.
	session   *apiSession
	owned     *apiSession
	disposed  bool
	lastError *string
	ended     EndedHandler
}
