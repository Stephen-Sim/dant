package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
)

// Optional preserves all three wire states: omitted, explicit null and value.
// omitzero uses IsZero so omission never becomes an invented null or timestamp.
type Optional[T any] struct {
	Value   T
	Present bool
	Null    bool
}

func Some[T any](value T) Optional[T]    { return Optional[T]{Value: value, Present: true} }
func Null[T any]() Optional[T]           { return Optional[T]{Present: true, Null: true} }
func (value Optional[T]) IsZero() bool   { return !value.Present }
func (value Optional[T]) Get() (T, bool) { return value.Value, value.Present && !value.Null }
func (value Optional[T]) MarshalJSON() ([]byte, error) {
	if !value.Present || value.Null {
		return []byte("null"), nil
	}
	return json.Marshal(value.Value)
}

func (value *Optional[T]) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*value = Null[T]()
		return nil
	}
	var decoded T
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	*value = Some(decoded)
	return nil
}

type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleSystem    Role = "system"
)

func (value Role) Valid() bool {
	return value == RoleUser || value == RoleAssistant || value == RoleSystem
}

// MessageStatus includes display-only assistant states alongside TaskStatus.
type MessageStatus string

const (
	MessageStatusStreaming MessageStatus = "streaming"
	MessageStatusRead      MessageStatus = "read"
)

func (value MessageStatus) Valid() bool {
	return value == MessageStatusStreaming || value == MessageStatusRead || TaskStatus(value).Valid()
}

func (value *MessageStatus) UnmarshalJSON(raw []byte) error {
	var decoded string
	if json.Unmarshal(raw, &decoded) != nil || !MessageStatus(decoded).Valid() {
		return errors.New("invalid message status")
	}
	*value = MessageStatus(decoded)
	return nil
}

type Attachment struct {
	ID            string            `json:"id"`
	Name          string            `json:"name,omitempty"`
	Type          string            `json:"type,omitempty"`
	Size          Optional[float64] `json:"size,omitzero"`
	Hash          string            `json:"hash,omitempty"`
	SHA256        string            `json:"sha256,omitempty"`
	GuestPath     string            `json:"guestPath,omitempty"`
	Path          string            `json:"path,omitempty"`
	SourcePath    string            `json:"sourcePath,omitempty"`
	Transcription string            `json:"transcription,omitempty"`
	Unavailable   Optional[bool]    `json:"unavailable,omitzero"`
	Extra         RawObject         `json:"-"`
	LegacyText    LegacyJSON        `json:"-"`
}
type VMSettings struct {
	Host       string     `json:"host"`
	User       string     `json:"user"`
	Port       float64    `json:"port"`
	KeyPath    string     `json:"keyPath"`
	KnownHosts string     `json:"knownHosts"`
	Extra      RawObject  `json:"-"`
	LegacyText LegacyJSON `json:"-"`
}
type Settings struct {
	Language         string     `json:"language"`
	Voice            string     `json:"voice"`
	NativeVoice      string     `json:"nativeVoice,omitempty"`
	APIVoice         string     `json:"apiVoice,omitempty"`
	Model            string     `json:"model"`
	Notifications    bool       `json:"notifications"`
	ShowWorkSummary  bool       `json:"showWorkSummary"`
	ShowCallCaptions bool       `json:"showCallCaptions"`
	VM               VMSettings `json:"vm"`
	TimeZone         string     `json:"timeZone,omitempty"`
	Extra            RawObject  `json:"-"`
	LegacyText       LegacyJSON `json:"-"`
}
type PlanStep struct {
	Step       string         `json:"step"`
	Status     PlanStepStatus `json:"status"`
	Extra      RawObject      `json:"-"`
	LegacyText LegacyJSON     `json:"-"`
}
type TaskPlan struct {
	Total       int        `json:"total"`
	Completed   int        `json:"completed"`
	CurrentStep string     `json:"currentStep"`
	Steps       []PlanStep `json:"steps"`
	Extra       RawObject  `json:"-"`
	LegacyText  LegacyJSON `json:"-"`
}
type WorkReplyTarget struct {
	WorkID         string     `json:"workId"`
	TurnID         string     `json:"turnId"`
	ConversationID string     `json:"conversationId"`
	Extra          RawObject  `json:"-"`
	LegacyText     LegacyJSON `json:"-"`
}
type ContinuationDispatch struct {
	ID         string                    `json:"id"`
	FromTurnID string                    `json:"fromTurnId"`
	RuntimeID  string                    `json:"runtimeId"`
	ThreadID   string                    `json:"threadId"`
	Phase      ContinuationDispatchPhase `json:"phase"`
	CreatedAt  float64                   `json:"createdAt"`
	TurnID     string                    `json:"turnId,omitempty"`
	Extra      RawObject                 `json:"-"`
	LegacyText LegacyJSON                `json:"-"`
}
type WorkContinuation struct {
	NextAt          Optional[float64]     `json:"nextAt,omitzero"`
	Attempts        int                   `json:"attempts"`
	NoProgressCount int                   `json:"noProgressCount"`
	LastCheckpoint  string                `json:"lastCheckpoint"`
	Invalid         bool                  `json:"invalid,omitempty"`
	Dispatch        *ContinuationDispatch `json:"dispatch,omitempty"`
	Extra           RawObject             `json:"-"`
	LegacyText      LegacyJSON            `json:"-"`
}
type ChatMessage struct {
	ID                         string                     `json:"id"`
	Role                       Role                       `json:"role"`
	Time                       Optional[float64]          `json:"time,omitzero"`
	Text                       string                     `json:"text,omitempty"`
	Status                     Optional[MessageStatus]    `json:"status,omitzero"`
	Submission                 Optional[SubmissionStatus] `json:"submission,omitzero"`
	Read                       bool                       `json:"read"`
	Reactions                  []string                   `json:"reactions"`
	Attachments                []Attachment               `json:"attachments,omitempty"`
	TurnID                     Optional[string]           `json:"turnId,omitzero"`
	TaskID                     Optional[string]           `json:"taskId,omitzero"`
	MessageID                  Optional[string]           `json:"messageId,omitzero"`
	WorkID                     string                     `json:"workId,omitempty"`
	ParentTaskID               Optional[string]           `json:"parentTaskId,omitzero"`
	TurnIDs                    []string                   `json:"turnIds,omitempty"`
	MessageIDs                 []string                   `json:"messageIds,omitempty"`
	ReplyTo                    Optional[string]           `json:"replyTo,omitzero"`
	ClientMessageID            string                     `json:"clientMessageId,omitempty"`
	WorkReply                  *WorkReplyTarget           `json:"workReply,omitempty"`
	UnknownOutcome             bool                       `json:"unknownOutcome,omitempty"`
	PauseReason                Optional[string]           `json:"pauseReason,omitzero"`
	Error                      Optional[string]           `json:"error,omitzero"`
	ProgressPriority           Optional[TaskPriority]     `json:"progressPriority,omitzero"`
	ProgressDismissedAt        Optional[float64]          `json:"progressDismissedAt,omitzero"`
	ReadAt                     Optional[float64]          `json:"readAt,omitzero"`
	VisibleAt                  Optional[float64]          `json:"visibleAt,omitzero"`
	VisibleAttachmentIDs       []string                   `json:"visibleAttachmentIds,omitempty"`
	Receipt                    RawObject                  `json:"receipt,omitempty"`
	ReceivedAt                 Optional[float64]          `json:"receivedAt,omitzero"`
	QueuedAt                   Optional[float64]          `json:"queuedAt,omitzero"`
	ExecutorConfirmedAt        Optional[float64]          `json:"executorConfirmedAt,omitzero"`
	AcceptedAt                 Optional[float64]          `json:"acceptedAt,omitzero"`
	ExecutionEndedAt           Optional[float64]          `json:"executionEndedAt,omitzero"`
	EditedAt                   Optional[float64]          `json:"editedAt,omitzero"`
	CancelledAt                Optional[float64]          `json:"cancelledAt,omitzero"`
	AssistantReaction          Optional[string]           `json:"assistantReaction,omitzero"`
	ReactionUpdatedAt          Optional[float64]          `json:"reactionUpdatedAt,omitzero"`
	AssistantReactionUpdatedAt Optional[float64]          `json:"assistantReactionUpdatedAt,omitzero"`
	Starred                    Optional[bool]             `json:"starred,omitzero"`
	Pinned                     Optional[bool]             `json:"pinned,omitzero"`
	Source                     RawObject                  `json:"source,omitempty"`
	WorkKind                   string                     `json:"workKind,omitempty"`
	Work                       RawObject                  `json:"work,omitempty"`
	Continuation               *WorkContinuation          `json:"continuation,omitempty"`
	CallID                     string                     `json:"callId,omitempty"`
	VoiceCallID                string                     `json:"voiceCallId,omitempty"`
	Voice                      bool                       `json:"voice,omitempty"`
	Kind                       string                     `json:"kind,omitempty"`
	Provider                   string                     `json:"provider,omitempty"`
	Seconds                    Optional[float64]          `json:"seconds,omitzero"`
	VoiceContext               RawObject                  `json:"voiceContext,omitempty"`
	CallContext                RawObject                  `json:"callContext,omitempty"`
	TelegramDelivery           RawObject                  `json:"telegramDelivery,omitempty"`
	TelegramMirror             RawObject                  `json:"telegramMirror,omitempty"`
	Scheduled                  bool                       `json:"scheduled,omitempty"`
	ScheduledAt                Optional[float64]          `json:"scheduledAt,omitzero"`
	ScheduleID                 string                     `json:"scheduleId,omitempty"`
	Extra                      RawObject                  `json:"-"`
	LegacyText                 LegacyJSON                 `json:"-"`
}
type Message = ChatMessage
type MessagePatch RawObject
type WorkRecord struct {
	ID                  string                     `json:"id"`
	TurnID              string                     `json:"turnId"`
	TurnIDs             []string                   `json:"turnIds"`
	Title               string                     `json:"title"`
	Status              WorkStatus                 `json:"status"`
	Source              string                     `json:"source"`
	Plan                *TaskPlan                  `json:"plan"`
	StartedAt           float64                    `json:"startedAt"`
	UpdatedAt           float64                    `json:"updatedAt"`
	ExecutionEndedAt    Optional[float64]          `json:"executionEndedAt,omitzero"`
	MessageID           Optional[string]           `json:"messageId,omitzero"`
	MessageIDs          []string                   `json:"messageIds,omitempty"`
	TaskID              Optional[string]           `json:"taskId,omitzero"`
	ProgressPriority    Optional[TaskPriority]     `json:"progressPriority,omitzero"`
	ProgressDismissedAt Optional[float64]          `json:"progressDismissedAt,omitzero"`
	UnknownOutcome      bool                       `json:"unknownOutcome,omitempty"`
	Submission          Optional[SubmissionStatus] `json:"submission,omitzero"`
	Continuation        *WorkContinuation          `json:"continuation,omitempty"`
	PauseReason         Optional[string]           `json:"pauseReason,omitzero"`
	CancelledAt         Optional[float64]          `json:"cancelledAt,omitzero"`
	Provisional         bool                       `json:"provisional,omitempty"`
	ProjectContext      RawObject                  `json:"projectContext,omitempty"`
	Extra               RawObject                  `json:"-"`
	LegacyText          LegacyJSON                 `json:"-"`
}
type Completion struct {
	ID                  string                 `json:"id"`
	TurnID              string                 `json:"turnId,omitempty"`
	MessageIDs          []string               `json:"messageIds"`
	TaskID              Optional[string]       `json:"taskId,omitzero"`
	At                  Optional[float64]      `json:"at,omitzero"`
	ReadAt              Optional[float64]      `json:"readAt,omitzero"`
	ProgressPriority    Optional[TaskPriority] `json:"progressPriority,omitzero"`
	ProgressDismissedAt Optional[float64]      `json:"progressDismissedAt,omitzero"`
	Work                RawObject              `json:"work,omitempty"`
	Extra               RawObject              `json:"-"`
	LegacyText          LegacyJSON             `json:"-"`
}
type State struct {
	Version                   int               `json:"version"`
	ConversationID            string            `json:"conversationId"`
	Messages                  []*ChatMessage    `json:"messages"`
	Memory                    string            `json:"memory"`
	Settings                  Settings          `json:"settings"`
	ThreadID                  Optional[string]  `json:"threadId,omitzero"`
	ThreadRuntime             Optional[string]  `json:"threadRuntime,omitzero"`
	ThreadConversationID      string            `json:"threadConversationId,omitempty"`
	Completions               []Completion      `json:"completions"`
	WorkTasks                 []WorkRecord      `json:"workTasks"`
	DeletedClientMessageIDs   []string          `json:"deletedClientMessageIds"`
	Schedules                 []json.RawMessage `json:"schedules,omitempty"`
	DeletedScheduleRequestIDs []string          `json:"deletedScheduleRequestIds,omitempty"`
	Presence                  RawObject         `json:"presence,omitempty"`
	VoiceHistory              []json.RawMessage `json:"voiceHistory,omitempty"`
	CallInputHistory          []json.RawMessage `json:"callInputHistory,omitempty"`
	TokenUsage                RawObject         `json:"tokenUsage,omitempty"`
	MemoryMigration           RawObject         `json:"memoryMigration,omitempty"`
	Extra                     RawObject         `json:"-"`
	LegacyText                LegacyJSON        `json:"-"`
}
type WorkerState struct {
	Status     ConnectionStatus `json:"status"`
	Error      Optional[string] `json:"error,omitzero"`
	RuntimeID  string           `json:"runtimeId,omitempty"`
	Generation uint64           `json:"generation"`
	Account    RawObject        `json:"account,omitempty"`
	Models     json.RawMessage  `json:"models,omitempty"`
	Realtime   RawObject        `json:"realtime,omitempty"`
}
type ActiveExecution struct {
	MessageID        Optional[string]       `json:"messageId,omitzero"`
	MessageIDs       []string               `json:"messageIds,omitempty"`
	TurnID           Optional[string]       `json:"turnId,omitzero"`
	ThreadID         Optional[string]       `json:"threadId,omitzero"`
	WorkID           string                 `json:"workId,omitempty"`
	Status           TaskStatus             `json:"status"`
	Source           string                 `json:"source"`
	Background       bool                   `json:"background"`
	StartedAt        Optional[float64]      `json:"startedAt,omitzero"`
	UpdatedAt        Optional[float64]      `json:"updatedAt,omitzero"`
	Step             TaskProgressStage      `json:"step"`
	Plan             *TaskPlan              `json:"plan,omitempty"`
	Title            string                 `json:"title,omitempty"`
	CallID           Optional[string]       `json:"callId,omitzero"`
	Visible          Optional[bool]         `json:"visible,omitzero"`
	CanSteer         bool                   `json:"canSteer"`
	ProgressPriority Optional[TaskPriority] `json:"progressPriority,omitzero"`
}
type Call struct {
	ID          string            `json:"id"`
	Started     Optional[float64] `json:"started,omitzero"`
	ConnectedAt Optional[float64] `json:"connectedAt,omitzero"`
	Status      VoiceCallStatus   `json:"status"`
	Provider    string            `json:"provider"`
}
type ExecutorState struct {
	Paused           bool `json:"paused"`
	ConfirmedStopped bool `json:"confirmedStopped"`
}
type WorkerSnapshot struct {
	Mode           string           `json:"mode"`
	ConversationID string           `json:"conversationId"`
	Messages       []*ChatMessage   `json:"messages"`
	Completions    []Completion     `json:"completions"`
	WorkTasks      []WorkRecord     `json:"workTasks"`
	Settings       Settings         `json:"settings"`
	Worker         WorkerState      `json:"worker"`
	Active         *ActiveExecution `json:"active"`
	Queue          []string         `json:"queue"`
	Call           *Call            `json:"call"`
	Takeover       bool             `json:"takeover"`
	Acquiring      bool             `json:"acquiring"`
	Executor       ExecutorState    `json:"executor"`
	Extra          RawObject        `json:"-"`
	LegacyText     LegacyJSON       `json:"-"`
}

// LegacyJSON retains escaped user text until an explicit edit changes it.
// Identity fields never use this mechanism and are validated separately.
type LegacyJSON struct {
	Original RawObject
	Decoded  map[string]string
}

func (value *ChatMessage) ClearLegacyText(keys ...string) {
	for _, key := range keys {
		delete(value.LegacyText.Original, key)
		delete(value.LegacyText.Decoded, key)
	}
}

// These helpers retain future/legacy fields at the owning DTO boundary. Known
// fields always come from checked typed values, never the extension map.
func marshalExtended(value any, extra RawObject) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var fields RawObject
	if err = json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	known := make(map[string]bool)
	typ := reflect.TypeOf(value)
	for index := 0; index < typ.NumField(); index++ {
		name := typ.Field(index).Tag.Get("json")
		if cut := bytes.IndexByte([]byte(name), ','); cut >= 0 {
			name = name[:cut]
		}
		if name != "" && name != "-" {
			known[name] = true
		}
	}
	object := reflect.ValueOf(value)
	if legacyField := object.FieldByName("LegacyText"); legacyField.IsValid() {
		legacy, ok := legacyField.Interface().(LegacyJSON)
		if ok {
			for key, original := range legacy.Original {
				for index := 0; index < typ.NumField(); index++ {
					field := typ.Field(index)
					name := field.Tag.Get("json")
					if cut := bytes.IndexByte([]byte(name), ','); cut >= 0 {
						name = name[:cut]
					}
					current := object.Field(index)
					if name == key && current.Kind() == reflect.String && current.String() == legacy.Decoded[key] {
						fields[key] = original
						break
					}
				}
			}
		}
	}
	for key, value := range extra {
		if !known[key] {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}

func unmarshalExtended(raw []byte, value any) (RawObject, error) {
	fields, err := DecodeObject(raw, len(raw))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, value); err != nil {
		return nil, err
	}
	typ := reflect.TypeOf(value).Elem()
	object := reflect.ValueOf(value).Elem()
	legacy := LegacyJSON{Original: make(RawObject), Decoded: make(map[string]string)}
	for index := 0; index < typ.NumField(); index++ {
		field := typ.Field(index)
		name := field.Tag.Get("json")
		if cut := bytes.IndexByte([]byte(name), ','); cut >= 0 {
			name = name[:cut]
		}
		current := object.Field(index)
		if (name == "text" || name == "title" || name == "step" || name == "currentStep" || name == "name" || name == "transcription" || name == "memory") && current.Kind() == reflect.String && bytes.Contains(fields[name], []byte("\\u")) {
			legacy.Original[name] = fields[name]
			legacy.Decoded[name] = current.String()
		}
	}
	if field := object.FieldByName("LegacyText"); field.IsValid() {
		field.Set(reflect.ValueOf(legacy))
	}
	for index := 0; index < typ.NumField(); index++ {
		field := typ.Field(index)
		name := field.Tag.Get("json")
		if cut := bytes.IndexByte([]byte(name), ','); cut >= 0 {
			name = name[:cut]
		}
		if name != "" && name != "-" {
			delete(fields, name)
		}
	}
	return fields, nil
}

func (value Attachment) MarshalJSON() ([]byte, error) {
	type wire Attachment
	return marshalExtended(wire(value), value.Extra)
}

func (value *Attachment) UnmarshalJSON(raw []byte) error {
	type wire Attachment
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = Attachment(decoded)
	value.Extra = extra
	return nil
}

func (value VMSettings) MarshalJSON() ([]byte, error) {
	type wire VMSettings
	return marshalExtended(wire(value), value.Extra)
}

func (value *VMSettings) UnmarshalJSON(raw []byte) error {
	type wire VMSettings
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = VMSettings(decoded)
	value.Extra = extra
	return nil
}

func (value Settings) MarshalJSON() ([]byte, error) {
	type wire Settings
	return marshalExtended(wire(value), value.Extra)
}

func (value *Settings) UnmarshalJSON(raw []byte) error {
	type wire Settings
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = Settings(decoded)
	value.Extra = extra
	return nil
}

func (value ChatMessage) MarshalJSON() ([]byte, error) {
	type wire ChatMessage
	return marshalExtended(wire(value), value.Extra)
}

func (value *ChatMessage) UnmarshalJSON(raw []byte) error {
	type wire ChatMessage
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = ChatMessage(decoded)
	value.Extra = extra
	return nil
}

func (value WorkRecord) MarshalJSON() ([]byte, error) {
	type wire WorkRecord
	return marshalExtended(wire(value), value.Extra)
}

func (value *WorkRecord) UnmarshalJSON(raw []byte) error {
	type wire WorkRecord
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = WorkRecord(decoded)
	value.Extra = extra
	return nil
}

func (value Completion) MarshalJSON() ([]byte, error) {
	type wire Completion
	return marshalExtended(wire(value), value.Extra)
}

func (value *Completion) UnmarshalJSON(raw []byte) error {
	type wire Completion
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = Completion(decoded)
	value.Extra = extra
	return nil
}

func (value State) MarshalJSON() ([]byte, error) {
	type wire State
	return marshalExtended(wire(value), value.Extra)
}

func (value *State) UnmarshalJSON(raw []byte) error {
	type wire State
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = State(decoded)
	value.Extra = extra
	return nil
}

func (value WorkerSnapshot) MarshalJSON() ([]byte, error) {
	type wire WorkerSnapshot
	return marshalExtended(wire(value), value.Extra)
}

func (value *WorkerSnapshot) UnmarshalJSON(raw []byte) error {
	type wire WorkerSnapshot
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = WorkerSnapshot(decoded)
	value.Extra = extra
	return nil
}

func (value PlanStep) MarshalJSON() ([]byte, error) {
	type wire PlanStep
	return marshalExtended(wire(value), value.Extra)
}

func (value *PlanStep) UnmarshalJSON(raw []byte) error {
	type wire PlanStep
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = PlanStep(decoded)
	value.Extra = extra
	return nil
}

func (value TaskPlan) MarshalJSON() ([]byte, error) {
	type wire TaskPlan
	return marshalExtended(wire(value), value.Extra)
}

func (value *TaskPlan) UnmarshalJSON(raw []byte) error {
	type wire TaskPlan
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = TaskPlan(decoded)
	value.Extra = extra
	return nil
}

func (value WorkReplyTarget) MarshalJSON() ([]byte, error) {
	type wire WorkReplyTarget
	return marshalExtended(wire(value), value.Extra)
}

func (value *WorkReplyTarget) UnmarshalJSON(raw []byte) error {
	type wire WorkReplyTarget
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = WorkReplyTarget(decoded)
	value.Extra = extra
	return nil
}

func (value ContinuationDispatch) MarshalJSON() ([]byte, error) {
	type wire ContinuationDispatch
	return marshalExtended(wire(value), value.Extra)
}

func (value *ContinuationDispatch) UnmarshalJSON(raw []byte) error {
	type wire ContinuationDispatch
	var decoded wire
	// The old Controller pause barrier emitted accepted. Preserve its spelling
	// while consuming the same confirmed binding semantics as acknowledged.
	fields, decodeErr := DecodeObject(raw, len(raw))
	legacyAccepted := decodeErr == nil && bytes.Equal(bytes.TrimSpace(fields["phase"]), []byte(`"accepted"`))
	if legacyAccepted {
		fields["phase"] = json.RawMessage(`"acknowledged"`)
		raw, decodeErr = json.Marshal(fields)
	}
	if decodeErr != nil {
		return decodeErr
	}
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = ContinuationDispatch(decoded)
	value.Extra = extra
	if legacyAccepted {
		value.LegacyText.Original["phase"] = json.RawMessage(`"accepted"`)
		value.LegacyText.Decoded["phase"] = string(ContinuationDispatchPhaseAcknowledged)
	}
	return nil
}

func (value WorkContinuation) MarshalJSON() ([]byte, error) {
	type wire WorkContinuation
	return marshalExtended(wire(value), value.Extra)
}

func (value *WorkContinuation) UnmarshalJSON(raw []byte) error {
	type wire WorkContinuation
	var decoded wire
	extra, err := unmarshalExtended(raw, &decoded)
	if err != nil {
		return err
	}
	*value = WorkContinuation(decoded)
	value.Extra = extra
	return nil
}
