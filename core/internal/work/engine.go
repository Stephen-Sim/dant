package work

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const (
	MaxQueue        = 4096
	MaxEarlyEvents  = 128
	MaxEarlyBytes   = 1024 * 1024
	MaxCompletedIDs = 4096
	MaxToolWorkers  = 4
)

type execution struct {
	epoch          uint64
	conversationID string
	messageID      string
	threadID       string
	runtimeID      string
	turnID         string
	workID         string
	attemptID      string
	fromTurnID     string
	messageIDs     []string
	assistantIDs   []string
	startedAt      float64
	updatedAt      float64
	step           contracts.TaskProgressStage

	startSubmitted      bool
	startAcknowledged   bool
	startRejected       bool
	terminal            bool
	finishing           bool
	stopRequested       bool
	stopReason          string
	cancelRequested     bool
	pauseOnly           bool
	unknown             bool
	waiting             bool
	planWaiting         bool
	credentialWaits     int
	credentialNotified  bool
	inputDelivered      bool
	blockerSequence     int
	requestNotices      map[string]bool
	workObserved        bool
	humanResponse       bool
	nativeVoice         bool
	voiceTask           bool
	conversationalInput bool
	nativeBackground    bool
	callID              string
	handoffID           string
	nativeAdmission     *ContinuationAdmission
	record              *contracts.WorkRecord

	outputs           map[string]string
	outputOrder       []string
	outputMeta        map[string]quietOutput
	quietTexts        []quietOutput
	deliveredTexts    map[string]bool
	deliveredMCP      map[string]bool
	items             map[string]string
	early             []runtime.Event
	earlyBytes        int
	baseline          json.RawMessage
	stopped           chan struct{}
	prepare           context.Context
	cancelPreparation context.CancelFunc
	steer             sync.Mutex
}

type Engine struct {
	ctx     context.Context
	cancel  context.CancelFunc
	store   *store.Store
	worker  Worker
	options Options

	mu               sync.Mutex
	closed           bool
	paused           bool
	pauseReason      string
	takeover         bool
	acquiring        bool
	confirmedStopped bool
	loaded           bool
	epoch            uint64
	active           *execution
	queue            []string
	pendingFollowups map[string]bool
	pendingRequests  map[string]runtime.Event
	completedTurns   []string
	completedItems   []string

	changes                 map[chan struct{}]struct{}
	signals                 map[chan Signal]struct{}
	wake                    chan struct{}
	workers                 sync.WaitGroup
	eventCancel             func()
	threadMu                sync.Mutex
	openingThread           bool
	threadReady             chan struct{}
	callReservation         *CallStartReservation
	computerAcquireReserved bool
	toolSlots               chan struct{}
	quietFiles              map[string][]contracts.Attachment
	quietFileOrder          []string
	referenceGate           chan struct{}
	referencePending        int
	voiceTasks              map[string]*voiceTask
	maintenance             bool
	inheritedStopFence      bool
}

func New(ctx context.Context, persistence *store.Store, worker Worker, options Options) (*Engine, error) {
	if persistence == nil || worker == nil {
		return nil, ErrClosed
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = store.UUID
	}
	if options.Tools == nil {
		options.Tools = DynamicTools()
	}
	lifetime, cancel := context.WithCancel(ctx)
	value := &Engine{
		ctx:     lifetime,
		cancel:  cancel,
		store:   persistence,
		worker:  worker,
		options: options,

		queue:            []string{},
		pendingFollowups: make(map[string]bool),
		pendingRequests:  make(map[string]runtime.Event),
		changes:          make(map[chan struct{}]struct{}),
		wake:             make(chan struct{}, 1),
		confirmedStopped: true,

		toolSlots:  make(chan struct{}, MaxToolWorkers),
		quietFiles: make(map[string][]contracts.Attachment),
	}
	value.referenceGate = make(chan struct{}, 1)
	value.voiceTasks = make(map[string]*voiceTask)
	state := persistence.Snapshot()
	if reason := unconfirmedPauseReason(state); reason != "" {
		value.pauseLocked(reason)
	}
	_, value.inheritedStopFence = state.Extra[executorStopFenceKey]
	value.workers.Add(1)
	go value.run()
	return value, nil
}

func (value *Engine) Store() *store.Store {
	return value.store
}

func (value *Engine) Timestamp() float64 {
	return float64(value.options.Now().UnixMilli())
}

func (value *Engine) changeLocked() {
	for channel := range value.changes {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}

func (value *Engine) Change() {
	value.mu.Lock()
	value.changeLocked()
	value.mu.Unlock()
	value.Wake()
}

func (value *Engine) Wake() {
	select {
	case value.wake <- struct{}{}:
	default:
	}
}

func (value *Engine) Subscribe() (
	<-chan struct{},
	func()) {
	value.mu.Lock()
	defer value.mu.Unlock()
	channel := make(chan struct{}, 1)
	if value.closed {
		close(channel)
		return channel, func() {}
	}
	value.changes[channel] = struct{}{}
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			value.mu.Lock()
			defer value.mu.Unlock()
			if _, exists := value.changes[channel]; exists {
				delete(value.changes, channel)
				close(channel)
			}
		})
	}
}

func (value *Engine) Snapshot() Snapshot {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.snapshotLocked()
}

func (value *Engine) StateSnapshot() (contracts.State, Snapshot) {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.store.Snapshot(), value.snapshotLocked()
}

func (value *Engine) snapshotLocked() Snapshot {
	result := Snapshot{Queue: append([]string{}, value.queue...), Takeover: value.takeover, Acquiring: value.acquiring, Executor: contracts.ExecutorState{Paused: value.paused, ConfirmedStopped: value.confirmedStopped}, PendingFollowups: []string{}}
	for id := range value.pendingFollowups {
		result.PendingFollowups = append(result.PendingFollowups, id)
	}
	if active := value.active; active != nil {
		status := contracts.TaskStatusRunning
		if active.waiting || active.planWaiting || active.credentialWaits > 0 {
			status = contracts.TaskStatusWaitingUser
		}
		if active.stopRequested {
			status = contracts.TaskStatusPausing
		}
		if active.unknown {
			status = contracts.TaskStatusUnknown
		}
		result.Active = &contracts.ActiveExecution{MessageID: contracts.Some(active.messageID), MessageIDs: append([]string{}, active.messageIDs...), TurnID: contracts.Null[string](), ThreadID: contracts.Null[string](), WorkID: active.workID, Status: status, Source: "chat", StartedAt: contracts.Some(active.startedAt), UpdatedAt: contracts.Some(active.updatedAt), Step: active.step}
		result.Active.CallID = contracts.Null[string]()
		if active.callID != "" {
			result.Active.CallID = contracts.Some(active.callID)
		}
		result.Active.CanSteer = active.startAcknowledged && active.turnID != "" && !active.stopRequested && !active.finishing && !active.unknown && !value.takeover && !value.acquiring && (!active.nativeVoice || active.nativeBackground)
		if active.finishing {
			result.Active.Step = contracts.TaskProgressStageSaving
		}
		if status == contracts.TaskStatusRunning && active.conversationalInput && active.record == nil && !active.workObserved {
			result.Active.Visible = contracts.Some(false)
		}
		if active.nativeVoice {
			result.Active.Source = "voice"
			result.Active.Background = active.nativeBackground
		}
		if active.turnID != "" {
			result.Active.TurnID = contracts.Some(active.turnID)
		}
		if active.threadID != "" {
			result.Active.ThreadID = contracts.Some(active.threadID)
		}
		if active.record != nil {
			result.Active.Title = active.record.Title
			result.Active.Source = active.record.Source
			result.Active.ProgressPriority = active.record.ProgressPriority
			if workstate.ValidTime(active.record.StartedAt) {
				result.Active.StartedAt = contracts.Some(active.record.StartedAt)
			}
			if active.record.Plan != nil {
				raw, _ := json.Marshal(active.record.Plan)
				_ = json.Unmarshal(raw, &result.Active.Plan)
			}
		}
		result.Finishing = active.finishing
	}
	if value.options.Calls != nil {
		result.Call = value.options.Calls.Snapshot()
	}
	return result
}

func (value *Engine) Current(owner ToolContext) bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	active := value.active
	return !value.closed && !value.takeover && !value.acquiring && active != nil && !active.finishing && !active.stopRequested && !active.unknown && active.conversationID == owner.ConversationID && active.turnID == owner.TurnID && active.threadID == owner.ThreadID && active.startAcknowledged && value.store.ConversationID() == owner.ConversationID && value.worker.Snapshot().Status == contracts.ConnectionStatusOnline
}

func (value *Engine) current(active *execution) bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.currentLocked(active)
}

func (value *Engine) currentLocked(active *execution) bool {
	return !value.closed && value.active == active && active.epoch == value.epoch && value.store.ConversationID() == active.conversationID
}

func (value *Engine) dispatchCurrent(active *execution) bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.currentLocked(active) && !active.finishing && !active.stopRequested && !active.unknown
}

func (value *Engine) HistoryTransaction(
	ctx context.Context,
	operation func(history.Ownership) (history.QueueChange, error)) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || value.maintenance {
		return ErrClosed
	}
	owner := history.Ownership{Queue: append([]string{}, value.queue...), Finishing: value.active != nil && value.active.finishing, PendingFollowups: len(value.pendingFollowups)}
	if value.active != nil {
		owner.ActiveIDs = append([]string{}, value.active.messageIDs...)
	}
	if value.options.Calls != nil {
		owner.Call = value.options.Calls.Snapshot() != nil
		owner.NativeVoiceActive = value.options.Calls.PendingWork()
	}
	change, err := operation(owner)
	if err != nil {
		return err
	}
	if change.Clear {
		value.queue = []string{}
	}
	if change.WithdrawID != "" {
		value.queue = slices.DeleteFunc(value.queue, func(id string) bool {
			return id == change.WithdrawID
		})
	}
	if change.EnqueueID != "" && !slices.Contains(value.queue, change.EnqueueID) {
		value.queue = append(value.queue, change.EnqueueID)
	}
	value.changeLocked()
	value.Wake()
	return nil
}

func (value *Engine) Enqueue(ctx context.Context, message *contracts.ChatMessage) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.enqueueLocked(ctx, message)
}

func (value *Engine) enqueueLocked(ctx context.Context, message *contracts.ChatMessage) error {
	if message == nil {
		return store.ErrMessageNotFound
	}
	if value.closed || value.maintenance {
		return ErrClosed
	}
	state := value.store.Snapshot()
	if _, present := state.Extra[executorStopFenceKey]; present {
		return ErrUnknown
	}
	current, err := store.FindMessage(&state, message.ID)
	if err != nil || current.Role != contracts.RoleUser {
		return store.ErrMessageNotFound
	}
	if value.active != nil && slices.Contains(value.active.messageIDs, current.ID) || slices.Contains(value.queue, current.ID) || value.pendingFollowups[current.ID] {
		return nil
	}
	if current.UnknownOutcome || current.Submission.Value == contracts.SubmissionStatusUnknown || current.Submission.Value == contracts.SubmissionStatusSubmitting {
		return ErrUnknown
	}
	if target := current.WorkReply; target != nil {
		if target.ConversationID != state.ConversationID {
			return ErrStaleOwner
		}
		record, lookupErr := store.FindWork(&state, target.WorkID)
		if lookupErr != nil || record.TurnID != target.TurnID || workstate.Unconfirmed(record) {
			return ErrStaleOwner
		}
		if active := value.active; active != nil && active.turnID == target.TurnID && active.workID == target.WorkID {
			if active.stopRequested || active.unknown || !active.startAcknowledged {
				return ErrUnknown
			}
			if len(value.pendingFollowups) >= MaxPendingFollowups {
				return runtime.ErrBackpressure
			}
			value.pendingFollowups[current.ID] = true
			value.workers.Add(1)
			go func() {
				defer value.workers.Done()
				_, _ = value.followup(value.ctx, current, target.TurnID, true)
			}()
			return nil
		}
		if !workstate.ReplyEligible(record, value.Timestamp()) {
			return ErrStaleOwner
		}
	}
	if len(value.queue) >= MaxQueue {
		return runtime.ErrBackpressure
	}
	if reason := value.admissionPauseReasonLocked(); reason != "" {
		_, err = value.store.Update(ctx, current.ID, patch(map[string]json.RawMessage{"status": raw(contracts.TaskStatusPaused), "pauseReason": raw(reason)}))
		return err
	}
	if call := value.CallSnapshot(); call != nil && call.Provider == "subscription" {
		_, err = value.store.Update(ctx, current.ID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusPaused), "pauseReason": raw(pauseReasonVoiceCall)}))
		return err
	}
	if _, err = value.store.Update(ctx, current.ID, patch(map[string]json.RawMessage{"status": raw(contracts.TaskStatusQueued), "queuedAt": raw(value.Timestamp()), "pauseReason": json.RawMessage("null")})); err != nil {
		return err
	}
	value.queue = append(value.queue, current.ID)
	value.changeLocked()
	value.Wake()
	return nil
}

func (value *Engine) run() {
	defer value.workers.Done()
	for {
		select {
		case <-value.ctx.Done():
			return
		case <-value.wake:
			value.pump()
		}
	}
}

func (value *Engine) pump() {
	value.mu.Lock()
	if value.callReservation != nil && value.callReservation.Provider == "subscription" {
		value.mu.Unlock()
		return
	}
	if value.closed || value.maintenance || value.paused || value.takeover || value.acquiring || value.openingThread || value.active != nil || len(value.queue) == 0 || value.worker.Snapshot().Status != contracts.ConnectionStatusOnline || (value.options.Calls != nil && value.options.Calls.PendingWork()) {
		value.mu.Unlock()
		return
	}
	state := value.store.Snapshot()
	messageID := value.queue[0]
	message, err := store.FindMessage(&state, messageID)
	voice := value.voiceTasks[messageID]
	if voice != nil {
		message, err = voice.message, nil
	}
	if err != nil {
		value.queue = value.queue[1:]
		value.mu.Unlock()
		value.Wake()
		return
	}
	if message.Scheduled && value.options.Calls != nil && value.options.Calls.Snapshot() != nil {
		value.mu.Unlock()
		return
	}
	if message.WorkReply != nil {
		value.queue = value.queue[1:]
		value.workers.Add(1)
		value.mu.Unlock()
		go func() {
			defer value.workers.Done()
			_, err := value.ContinueRegisteredWork(value.ctx, message.WorkReply.WorkID, ContinueOptions{ExpectedTurnID: message.WorkReply.TurnID, Message: message})
			if err != nil {
				_, _ = value.store.Update(value.ctx, message.ID, patch(contracts.RawObject{"status": raw(contracts.TaskStatusPaused), "pauseReason": raw("work-reply-unavailable")}))
			}
			value.Wake()
		}()
		return
	}
	if call := value.CallSnapshot(); call != nil && call.Provider == "subscription" {
		value.mu.Unlock()
		return
	}
	if unconfirmedState(state) {
		value.mu.Unlock()
		return
	}
	value.queue = value.queue[1:]
	value.epoch++
	prepare, cancel := context.WithCancel(value.ctx)
	active := &execution{epoch: value.epoch, conversationID: state.ConversationID, messageID: messageID, messageIDs: []string{messageID}, startedAt: value.Timestamp(), updatedAt: value.Timestamp(), step: contracts.TaskProgressStagePreparing, outputs: make(map[string]string), items: make(map[string]string), stopped: make(chan struct{}), prepare: prepare, cancelPreparation: cancel}
	active.conversationalInput = message.WorkKind == "conversation"
	if voice != nil {
		active.nativeVoice = true
		active.nativeBackground = voice.background
		active.callID = voice.callID
		active.voiceTask = true
	}
	value.active = active
	value.confirmedStopped = false
	value.changeLocked()
	value.workers.Add(1)
	value.mu.Unlock()
	go func() {
		defer value.workers.Done()
		value.start(active, message)
	}()
}

func unconfirmedState(state contracts.State) bool {
	return unconfirmedPauseReason(state) != ""
}

func (value *Engine) ensureEvents() error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed {
		return ErrClosed
	}
	if value.eventCancel != nil {
		return nil
	}
	events, cancel, err := value.worker.SubscribeEvents()
	if err != nil {
		return err
	}
	value.eventCancel = cancel
	value.workers.Add(1)
	go func() {
		defer value.workers.Done()
		for {
			select {
			case <-value.ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					value.disconnected()
					return
				}
				event = value.scopeMediaEvent(event)
				if event.IsRequest() && event.Method == "item/tool/call" {
					select {
					case value.toolSlots <- struct{}{}:
						value.mu.Lock()
						if value.closed {
							value.mu.Unlock()
							<-value.toolSlots
							return
						}
						value.workers.Add(1)
						value.mu.Unlock()
						go func() {
							defer value.workers.Done()
							defer func() {
								<-value.toolSlots
							}()
							_ = value.Handle(value.ctx, event)
						}()
					default:
						_ = value.rejectEvent(value.ctx, event)
					}
				} else {
					_ = value.Handle(value.ctx, event)
				}
			}
		}
	}()
	return nil
}

func (value *Engine) disconnected() {
	value.mu.Lock()
	cancel := value.eventCancel
	value.eventCancel = nil
	active := value.active
	if active != nil {
		active.unknown = active.startSubmitted && !active.terminal
		active.stopRequested = true
	}
	if active != nil {
		value.pauseLocked(pauseReasonDisconnected)
	}
	value.changeLocked()
	value.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if active != nil {
		_ = value.finish(active, contracts.TaskStatusPaused, pauseReasonDisconnected)
	}
}

func (value *Engine) start(active *execution, message *contracts.ChatMessage) {
	failed := func(err error) {
		value.mu.Lock()
		if value.active != active {
			value.mu.Unlock()
			return
		}
		unknown := active.startSubmitted && !active.startAcknowledged
		var operation *runtime.OperationError
		if errors.As(err, &operation) && !operation.UnknownOutcome {
			unknown = false
			// Only an explicit rejection proves a submitted start was not accepted.
			active.startRejected = active.startSubmitted && !active.startAcknowledged
		}
		active.unknown = unknown
		value.mu.Unlock()
		status := contracts.TaskStatusFailed
		if unknown || active.stopRequested {
			status = contracts.TaskStatusPaused
		}
		_ = value.finish(active, status, pauseReasonRequestFailed)
	}
	if err := value.ensureEvents(); err != nil {
		failed(err)
		return
	}
	if err := value.updateExecutionMessage(active, contracts.RawObject{"status": raw(contracts.TaskStatusRunning), "submission": raw(contracts.SubmissionStatusPreparing), "error": json.RawMessage("null")}); err != nil {
		failed(err)
		return
	}
	thread, err := value.thread(active)
	if err != nil {
		failed(err)
		return
	}
	value.mu.Lock()
	if !value.currentLocked(active) || active.stopRequested {
		value.mu.Unlock()
		failed(ErrPaused)
		return
	}
	active.threadID = thread
	value.mu.Unlock()
	input, err := value.prepareInput(active, message)
	if err != nil {
		failed(err)
		return
	}
	if value.options.Deliverables != nil {
		active.baseline, err = value.options.Deliverables.CaptureBaseline(active.prepare, value.outputDirectory(active.conversationID))
		if err != nil {
			failed(err)
			return
		}
	}
	value.mu.Lock()
	if !value.currentLocked(active) || active.stopRequested {
		value.mu.Unlock()
		failed(ErrPaused)
		return
	}
	active.startSubmitted = true
	value.mu.Unlock()
	if err = value.updateExecutionMessage(active, contracts.RawObject{"submission": raw(contracts.SubmissionStatusSubmitting)}); err != nil {
		failed(err)
		return
	}
	params := contracts.RawObject{"threadId": raw(thread), "input": input, "cwd": raw(value.workspace(active.conversationID)), "approvalPolicy": raw("never"), "sandboxPolicy": json.RawMessage(`{"type":"dangerFullAccess"}`)}
	if model := value.store.Snapshot().Settings.Model; model != "" {
		params["model"] = raw(model)
	}
	result, err := value.requestOwned(value.ctx, "turn/start", params, func() bool { return value.dispatchCurrent(active) })
	if err != nil {
		failed(err)
		return
	}
	var turn struct {
		ID string `json:"id"`
	}
	if !contracts.ValidUnicodeJSON(result["turn"]) || json.Unmarshal(result["turn"], &turn) != nil || !workstate.ValidID(turn.ID, workstate.ReferenceIDLength) {
		failed(runtime.ErrInvalidProtocol)
		return
	}
	value.mu.Lock()
	if !value.currentLocked(active) {
		value.mu.Unlock()
		return
	}
	active.turnID = turn.ID
	value.mu.Unlock()
	if err = value.updateExecutionMessage(active, contracts.RawObject{"submission": raw(contracts.SubmissionStatusConfirmed), "turnId": raw(turn.ID), "executorConfirmedAt": raw(value.Timestamp())}); err != nil {
		value.mu.Lock()
		active.unknown = true
		value.pauseLocked(pauseReasonUnknown)
		value.changeLocked()
		value.mu.Unlock()
		return
	}
	if active.voiceTask {
		record, recordErr := value.store.RegisterWork(value.ctx, store.RegisterWorkOptions{TurnID: turn.ID, MessageID: active.messageID, Source: "voice", Title: "Task from a call", Observed: true})
		if recordErr != nil {
			value.mu.Lock()
			active.unknown = true
			value.pauseLocked(pauseReasonUnknown)
			value.changeLocked()
			value.mu.Unlock()
			return
		}
		value.mu.Lock()
		active.record = record
		active.workID = record.ID
		value.changeLocked()
		value.mu.Unlock()
	}
	value.mu.Lock()
	if !value.currentLocked(active) {
		value.mu.Unlock()
		return
	}
	active.startAcknowledged = true
	active.step = contracts.TaskProgressStageWorking
	events := active.early
	active.early = nil
	active.earlyBytes = 0
	value.changeLocked()
	value.mu.Unlock()
	for _, event := range events {
		_ = value.Handle(value.ctx, event)
	}
}

func raw(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func patch(value contracts.RawObject) contracts.MessagePatch {
	return contracts.MessagePatch(value)
}

func (value *Engine) workspace(conversationID string) string {
	return filepath.Join(value.worker.WorkspaceRoot(), conversationID)
}

func (value *Engine) outputDirectory(conversationID string) string {
	return filepath.Join(value.workspace(conversationID), "output")
}

func (value *Engine) thread(active *execution) (string, error) {
	return value.openThread(active.prepare, active.conversationID, func() bool {
		return value.dispatchCurrent(active)
	})
}

func (value *Engine) openThread(
	ctx context.Context,
	conversationID string,
	isCurrent func() bool) (string, error) {
	value.threadMu.Lock()
	defer value.threadMu.Unlock()
	state := value.store.Snapshot()
	if state.ConversationID != conversationID || !isCurrent() {
		return "", ErrStaleOwner
	}
	if _, err := files.OrdinaryDirectory(value.outputDirectory(state.ConversationID), true); err != nil {
		return "", err
	}
	if state.ThreadID.Value != "" && state.ThreadRuntime.Value == "" {
		if err := value.store.Mutate(ctx, func(current *contracts.State) error {
			if current.ConversationID != conversationID || current.ThreadID.Value != state.ThreadID.Value {
				return ErrStaleOwner
			}
			current.ThreadRuntime = contracts.Some(value.worker.RuntimeID())
			current.ThreadConversationID = conversationID
			return nil
		}); err != nil {
			return "", err
		}
		state = value.store.Snapshot()
	}
	same := state.ThreadID.Value != "" && state.ThreadRuntime.Value == value.worker.RuntimeID() && state.ThreadConversationID == state.ConversationID
	value.mu.Lock()
	loaded := value.loaded
	value.mu.Unlock()
	if loaded && same {
		return state.ThreadID.Value, nil
	}
	instructions, err := value.buildInstructions(ctx, state)
	if err != nil {
		return "", err
	}
	params := contracts.RawObject{"cwd": raw(value.workspace(state.ConversationID)), "approvalPolicy": raw("never"), "sandbox": raw("danger-full-access"), "developerInstructions": raw(instructions), "persistExtendedHistory": raw(false)}
	if state.Settings.Model != "" {
		params["model"] = raw(state.Settings.Model)
	}
	method := "thread/start"
	if same {
		method = "thread/resume"
		params["threadId"] = raw(state.ThreadID.Value)
		params["excludeTurns"] = raw(true)
	} else {
		params["dynamicTools"] = raw(value.options.Tools)
		params["experimentalRawEvents"] = raw(false)
	}
	result, err := value.requestOwned(ctx, method, params, isCurrent)
	if err != nil {
		return "", err
	}
	id := state.ThreadID.Value
	if !same {
		var thread struct {
			ID string `json:"id"`
		}
		if !contracts.ValidUnicodeJSON(result["thread"]) || json.Unmarshal(result["thread"], &thread) != nil || !workstate.ValidID(thread.ID, workstate.ReferenceIDLength) {
			return "", runtime.ErrInvalidProtocol
		}
		id = thread.ID
	}
	if !isCurrent() {
		return "", ErrStaleOwner
	}
	err = value.store.Mutate(value.ctx, func(current *contracts.State) error {
		if current.ConversationID != conversationID {
			return ErrStaleOwner
		}
		current.ThreadID = contracts.Some(id)
		current.ThreadRuntime = contracts.Some(value.worker.RuntimeID())
		current.ThreadConversationID = current.ConversationID
		return nil
	})
	if err != nil {
		return "", err
	}
	value.mu.Lock()
	value.loaded = true
	value.mu.Unlock()
	return id, nil
}

func (value *Engine) Close() error {
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return nil
	}
	value.closed = true
	value.cancel()
	eventCancel := value.eventCancel
	for channel := range value.signals {
		close(channel)
		delete(value.signals, channel)
	}
	for channel := range value.changes {
		close(channel)
		delete(value.changes, channel)
	}
	value.mu.Unlock()
	if eventCancel != nil {
		eventCancel()
	}
	value.workers.Wait()
	return nil
}
