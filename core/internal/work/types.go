package work

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

var (
	ErrBusy       = errors.New("executor_busy")
	ErrPaused     = errors.New("executor_paused")
	ErrUnknown    = errors.New("execution_unconfirmed")
	ErrStaleOwner = errors.New("execution_owner_changed")
	ErrClosed     = errors.New("engine_closed")
)

// Worker is the Engine's process capability. A host Controller never constructs
// an Engine or implements this interface through local task execution.
type Worker interface {
	RuntimeID() string
	WorkspaceRoot() string
	Snapshot() contracts.WorkerState
	Connect(context.Context) (contracts.RawObject, error)
	Request(context.Context, string, contracts.RawObject) (contracts.RawObject, error)
	Reply(context.Context, runtime.RPCID, json.RawMessage) error
	SubscribeEvents() (
		<-chan runtime.Event,
		func(),
		error)
	TerminateConfirmed(context.Context) (bool, error)
}

type ToolContext struct {
	ConversationID string
	MessageID      string
	MessageIDs     []string
	WorkID         string
	TurnID         string
	ThreadID       string
	CallID         string
	Owner          string
	IsCurrent      func() bool
}
type ToolRouter interface {
	Execute(context.Context, string, contracts.RawObject, ToolContext) (json.RawMessage, error)
}
type ReferenceMemory interface {
	Context(context.Context, string, string, string) (string, error)
}
type ReferenceMemoryFunc func(context.Context, string, string, string) (string, error)

func (value ReferenceMemoryFunc) Context(ctx context.Context, query, conversationID, workID string) (string, error) {
	return value(ctx, query, conversationID, workID)
}

type DurableMemory interface {
	Context(context.Context, bool) (string, error)
	Directory() string
}
type Deliverables interface {
	CaptureBaseline(context.Context, string) (json.RawMessage, error)
	Archive(context.Context, string, string, json.RawMessage) ([]contracts.Attachment, error)
}

// AttachmentReader resolves immutable saved IDs in the current managed root and
// verifies their bounded bytes before an execution can receive a local path.
type AttachmentReader interface {
	Read(context.Context, string) (contracts.Attachment, []byte, error)
}

type TokenUsage interface {
	ObserveCodex(context.Context, string, json.RawMessage) (bool, error)
}

// ConversationSession is an independently owned model connection without
// computer, task, or external-action capabilities.
// The factory must establish its isolation before returning this capability.
// It never shares the ordinary task executor's thread or tool authority.
type ConversationSession interface {
	RuntimeID() string
	ValidateOwner() error
	RequestGuarded(context.Context, string, contracts.RawObject, func() error) (contracts.RawObject, error)
	SubscribeEvents() (<-chan runtime.Event, func(), error)
	ReplyError(context.Context, runtime.RPCID, int, string) error
	TerminateConfirmed(context.Context) (bool, error)
}

// CallService owns its media lifecycle. Durable task ownership remains here;
// closing media must not imply cancellation or successful task completion.
type CallService interface {
	Start(context.Context, contracts.RawObject) (contracts.Call, error)
	Stop(context.Context, string) error
	Snapshot() *contracts.Call
	OwnsEvent(runtime.Event) bool
	HandleEvent(context.Context, runtime.Event) error
	PauseWork(context.Context) error
	PendingWork() bool
}

type ContinuationOwner struct {
	ConversationID, WorkID, AttemptID, FromTurnID, ThreadID string
	EngineEpoch                                             uint64
}
type ContinuationAdmission struct {
	Owner                 ContinuationOwner
	CallID                string
	Generation, WorkEpoch uint64
}
type ContinuationCalls interface {
	CanContinueWhileIdle(ContinuationOwner) bool
	BeginContinuationAdmission(ContinuationOwner) (ContinuationAdmission, error)
	ConfirmContinuationAdmission(ContinuationAdmission, string) error
	ReplayContinuationEvents(context.Context, ContinuationAdmission, []runtime.Event, string, bool) ([]runtime.Event, bool, error)
	FinishContinuationAdmission(ContinuationAdmission)
}

type Options struct {
	Now                 func() time.Time
	NewID               func() string
	Instructions        string
	Tools               []json.RawMessage
	ToolRouter          ToolRouter
	Memory              ReferenceMemory
	DurableMemory       DurableMemory
	DesktopPath         string
	Usage               TokenUsage
	Deliverables        Deliverables
	Attachments         AttachmentReader
	Calls               CallService
	Redact              func(context.Context, string) string
	OwnerEnded          func(string)
	Transcribe          func(context.Context, contracts.Attachment) (string, error)
	RecognizedCallInput func(context.Context, string, *contracts.ChatMessage) error
	OpenConversation    func(context.Context, string, func() bool) (ConversationSession, error)
}

type Snapshot struct {
	Active           *contracts.ActiveExecution
	Queue            []string
	Call             *contracts.Call
	Takeover         bool
	Acquiring        bool
	Executor         contracts.ExecutorState
	Finishing        bool
	PendingFollowups []string
}

type ContinueOptions struct {
	ExpectedTurnID string
	Message        *contracts.ChatMessage
}
type ResumeOptions struct {
	ConfirmUnknown bool
}
