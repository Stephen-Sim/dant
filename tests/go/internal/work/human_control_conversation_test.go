package work

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type fakeConversationSession struct {
	*fakeWorker
	stopOnce         sync.Once
	mu               sync.Mutex
	stops            int
	stopErr          error
	closeOnTerminate bool
	ownerErr         error
}

func (value *fakeConversationSession) RuntimeID() string { return "conversation:fixture" }

func (value *fakeConversationSession) ValidateOwner() error {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.ownerErr
}

func (value *fakeConversationSession) RequestGuarded(ctx context.Context, method string, params contracts.RawObject, guard func() error) (contracts.RawObject, error) {
	if guard != nil {
		if err := guard(); err != nil {
			return nil, err
		}
	}
	return value.Request(ctx, method, params)
}

func (value *fakeConversationSession) SubscribeEvents() (<-chan runtime.Event, func(), error) {
	return value.events, func() { value.stopOnce.Do(func() { close(value.events) }) }, nil
}

func (value *fakeConversationSession) TerminateConfirmed(context.Context) (bool, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.stops++
	if value.closeOnTerminate {
		value.stopOnce.Do(func() { close(value.events) })
	}
	return value.stopErr == nil, value.stopErr
}

type conversationDeliverables struct{ captures, archives int }

func (value *conversationDeliverables) CaptureBaseline(context.Context, string) (json.RawMessage, error) {
	value.captures++
	return raw(map[string]string{}), nil
}

func (value *conversationDeliverables) Archive(context.Context, string, string, json.RawMessage) ([]contracts.Attachment, error) {
	value.archives++
	return nil, nil
}

func humanConversationFixture(t *testing.T) (*Engine, *store.Store, *fakeWorker, <-chan *fakeConversationSession) {
	t.Helper()
	engine, persistence, worker := engineFixture(t)
	sessions := make(chan *fakeConversationSession, 8)
	engine.options.OpenConversation = func(ctx context.Context, conversationID string, current func() bool) (ConversationSession, error) {
		if !current() || conversationID != persistence.ConversationID() {
			return nil, ErrStaleOwner
		}
		session := &fakeConversationSession{fakeWorker: &fakeWorker{requests: make(chan fakeRequest, 16), events: make(chan runtime.Event, 16), replies: make(chan json.RawMessage, 16)}}
		sessions <- session
		return session, nil
	}
	if err := engine.Acquire(t.Context()); err != nil {
		t.Fatal(err)
	}
	return engine, persistence, worker, sessions
}

func nextConversationSession(t *testing.T, sessions <-chan *fakeConversationSession) *fakeConversationSession {
	t.Helper()
	select {
	case session := <-sessions:
		return session
	case <-time.After(10 * time.Second):
		t.Fatal("restricted conversation session was not opened")
		return nil
	}
}

func acceptConversation(t *testing.T, session *fakeConversationSession, turnID string) {
	t.Helper()
	thread := nextRequest(t, session.fakeWorker, "thread/start")
	if eventString(thread.params, "sandbox") != "read-only" || string(thread.params["environments"]) != "[]" || string(thread.params["dynamicTools"]) != "[]" || string(thread.params["ephemeral"]) != "true" {
		t.Fatal("restricted thread requested ordinary execution capabilities")
	}
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	turn := nextRequest(t, session.fakeWorker, "turn/start")
	if _, present := turn.params["cwd"]; present || string(turn.params["environments"]) != "[]" || string(turn.params["sandboxPolicy"]) != `{"type":"readOnly","networkAccess":false}` {
		t.Fatal("restricted turn regained environment access")
	}
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(turnID)})}}
}

func conversationReply(turnID, text string) runtime.Event {
	return runtime.Event{Method: "item/completed", Params: contracts.RawObject{
		"threadId": raw("thread-fixture"), "turnId": raw(turnID),
		"item": raw(contracts.RawObject{"id": raw("conversation-answer-" + turnID), "type": raw("agentMessage"), "text": raw(text)}),
	}}
}

func TestHumanControlConversationImageUsesOnlyVerifiedInlineBytes(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	data := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1}
	attachment := contracts.Attachment{ID: "synthetic-image", Name: "synthetic.png", Type: "image/png", GuestPath: filepath.Join(t.TempDir(), "not-visible-inside-private-runtime.png")}
	engine.options.Attachments = attachmentReaderFunc(func(ctx context.Context, id string) (contracts.Attachment, []byte, error) {
		if id != attachment.ID {
			return contracts.Attachment{}, nil, store.ErrInvalidState
		}
		return attachment, data, nil
	})
	receipt, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Synthetic image question", ClientMessageID: returnedControlClientID,
		Attachments: []contracts.Attachment{attachment},
	})
	if err != nil || receipt.Message == nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	thread := nextRequest(t, session.fakeWorker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	turn := nextRequest(t, session.fakeWorker, "turn/start")
	var input []contracts.RawObject
	if json.Unmarshal(turn.params["input"], &input) != nil {
		t.Fatal("restricted input was not a checked input list")
	}
	found := false
	for _, item := range input {
		if eventString(item, "type") == "localImage" {
			t.Fatal("private runtime was given an inaccessible host image path")
		}
		if eventString(item, "type") == "image" {
			found = eventString(item, "url") == "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data)
		}
	}
	if !found || strings.Contains(string(turn.params["input"]), attachment.GuestPath) {
		t.Fatal("verified image bytes did not reach restricted model input")
	}
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("image-chat-turn")})}}
	session.events <- conversationReply("image-chat-turn", "Synthetic image answer")
	session.events <- terminal("image-chat-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationIncludesBoundedSharedRoleReferences(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	for _, message := range []*contracts.ChatMessage{
		{Role: contracts.RoleUser, Text: "Synthetic old instruction; reference only"},
		{Role: contracts.RoleAssistant, Text: "Synthetic earlier answer with a retained blue marker"},
	} {
		if _, err := persistence.Add(t.Context(), message); err != nil {
			t.Fatal(err)
		}
	}
	message, err := admitReturnedControlInput(t, engine, persistence, "web")
	if err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	thread := nextRequest(t, session.fakeWorker, "thread/start")
	instructions := eventString(thread.params, "developerInstructions")
	if !strings.Contains(instructions, "retained blue marker") || !strings.Contains(instructions, `"role":"assistant"`) || strings.Contains(instructions, message.Text) {
		t.Fatal("fresh thread lost shared roles or repeated the new input as reference")
	}
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	turn := nextRequest(t, session.fakeWorker, "turn/start")
	turn.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("context-chat-turn")})}}
	session.events <- conversationReply("context-chat-turn", "Synthetic context answer")
	session.events <- terminal("context-chat-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationRepliesWithoutDesktopOrTaskAuthority(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		t.Run(source, func(t *testing.T) {
			engine, persistence, worker, sessions := humanConversationFixture(t)
			deliverables := &conversationDeliverables{}
			engine.options.Deliverables = deliverables
			if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
				state.ThreadID = contracts.Some("retained-task-thread")
				state.ThreadRuntime = contracts.Some(worker.RuntimeID())
				state.ThreadConversationID = state.ConversationID
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			old, err := persistence.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "Synthetic retained unknown request",
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
				TurnID: contracts.Some("retained-unknown-turn"), PauseReason: contracts.Some(pauseReasonUnknown),
			})
			if err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(old)
			message, err := admitReturnedControlInput(t, engine, persistence, source)
			if err != nil || message == nil {
				t.Fatal(err)
			}
			session := nextConversationSession(t, sessions)
			acceptConversation(t, session, "human-chat-turn")
			waitSnapshot(t, engine, func(snapshot Snapshot) bool {
				return snapshot.Active != nil && snapshot.Active.TurnID.Value == "human-chat-turn"
			})
			if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused {
				t.Fatal("chat released human control or cleared the task pause")
			}
			if _, ok := engine.ToolScope(); ok {
				t.Fatal("conversation acquired native task-tool authority")
			}
			if _, err := engine.Tool(t.Context(), "task_plan", contracts.RawObject{}, ToolContext{IsCurrent: func() bool { return true }}); !errors.Is(err, ErrPaused) {
				t.Fatal("forged conversational tool owner reached task routing", err)
			}
			session.events <- conversationReply("human-chat-turn", "Synthetic conversational answer")
			session.events <- terminal("human-chat-turn", "completed")
			waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
			state := persistence.Snapshot()
			stored, _ := persistence.Message(message.ID)
			retained, _ := persistence.Message(old.ID)
			after, _ := json.Marshal(retained)
			if stored.Submission.Value != contracts.SubmissionStatusConfirmed || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) || string(before) != string(after) || state.ThreadID.Value != "retained-task-thread" || len(state.WorkTasks) != 0 {
				t.Fatal("reply changed prior task/thread ownership or lost its own receipt")
			}
			if len(state.Messages) != 3 || state.Messages[2].Text != "Synthetic conversational answer" || state.Messages[2].TaskID.Value != message.ID || deliverables.captures != 0 || deliverables.archives != 0 {
				t.Fatal("conversation reply was not delivered without file/task side effects")
			}
			if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused || !snapshot.Executor.ConfirmedStopped {
				t.Fatal("conversation completion changed human desktop ownership")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanControlConversationRejectsToolsAndUnboundWorkerEvents(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	if _, err := admitReturnedControlInput(t, engine, persistence, "web"); err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	session.closeOnTerminate = true
	acceptConversation(t, session, "human-chat-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "human-chat-turn"
	})
	if err := engine.Handle(t.Context(), conversationReply("human-chat-turn", "Synthetic stale ordinary-worker event")); err != nil {
		t.Fatal(err)
	}
	if len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("ordinary task worker impersonated the restricted reply")
	}
	for _, name := range []string{"task_plan", "send_chat_message", "credential_get", "desktop", "shell"} {
		session.events <- runtime.Event{ID: contracts.Some(runtime.NumericRPCID(1)), Method: "item/tool/call", Params: contracts.RawObject{"tool": raw(name), "arguments": raw(contracts.RawObject{})}}
		select {
		case <-session.replies:
		case <-time.After(10 * time.Second):
			t.Fatal("restricted tool request was not rejected")
		}
	}
	session.events <- runtime.Event{Method: "turn/plan/updated", Params: contracts.RawObject{"plan": raw([]contracts.PlanStep{{Step: "Synthetic forbidden work", Status: contracts.PlanStepStatusInProgress}})}}
	session.events <- runtime.Event{Method: "item/completed", Params: contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("forbidden-command"), "type": raw("commandExecution")})}}
	if err := engine.Release(); err != nil {
		t.Fatal(err)
	}
	if _, ok := engine.ToolScope(); ok {
		t.Fatal("returning desktop control escalated an existing restricted reply")
	}
	session.events <- conversationReply("human-chat-turn", "Synthetic safe answer")
	session.events <- terminal("human-chat-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	if len(persistence.Snapshot().WorkTasks) != 0 {
		t.Fatal("conversation observations created task work")
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationPreservesOtherSafetyStops(t *testing.T) {
	for _, source := range []string{"web", "telegram"} {
		for _, reason := range []string{pauseReasonUser, pauseReasonDisconnected, pauseReasonUnknown, pauseReasonStopUnknown, pauseReasonVoiceCall} {
			t.Run(source+"/"+reason, func(t *testing.T) {
				engine, persistence, worker, sessions := humanConversationFixture(t)
				engine.mu.Lock()
				engine.pauseReason = reason
				engine.mu.Unlock()
				message, err := admitReturnedControlInput(t, engine, persistence, source)
				if err != nil || message == nil {
					t.Fatal(err)
				}
				stored, _ := persistence.Message(message.ID)
				if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || len(engine.Snapshot().Queue) != 0 {
					t.Fatal("restricted admission cleared an independent pause")
				}
				select {
				case <-sessions:
					t.Fatal("an independent stop opened a model session")
				default:
				}
				assertWorkerQuiet(t, worker)
			})
		}
	}
}

func TestHumanControlConversationNeverAdoptsSchedulerOrExistingRetry(t *testing.T) {
	for _, scenario := range []string{"scheduler", "idempotent", "unknown-external", "submitting-external"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, sessions := humanConversationFixture(t)
			input := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic retained instruction", ClientMessageID: returnedControlClientID,
				Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), PauseReason: contracts.Some(pauseReasonHumanControl),
				Submission: contracts.Some(contracts.SubmissionStatusNotSubmitted)}
			if strings.HasSuffix(scenario, "external") {
				input.ClientMessageID = "tg:restricted-existing:1"
				input.Source = contracts.RawObject{"type": raw("telegram")}
				input.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft))
				input.Submission = contracts.Some(contracts.SubmissionStatusUnknown)
				input.UnknownOutcome = true
				if scenario == "submitting-external" {
					input.Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
					input.UnknownOutcome = false
				}
			}
			stored, err := persistence.Add(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "scheduler":
				err = engine.Enqueue(t.Context(), stored)
			case "idempotent":
				var receipt AdmissionReceipt
				receipt, err = engine.AdmitMessage(t.Context(), persistence.ConversationID(), input)
				if !receipt.Existing {
					t.Fatal("idempotent retry did not retain its original message")
				}
			default:
				err = engine.AdmitExternalMessage(t.Context(), persistence.ConversationID(), stored)
				if !errors.Is(err, ErrUnknown) {
					t.Fatal("unconfirmed external request bypassed its fence", err)
				}
				err = nil
			}
			if err != nil || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("existing work entered the fresh conversation queue", err)
			}
			select {
			case <-sessions:
				t.Fatal("existing work created a restricted turn")
			default:
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanControlConversationPauseStopsOnlyOwnedChild(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	message, err := admitReturnedControlInput(t, engine, persistence, "web")
	if err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	session.closeOnTerminate = true
	acceptConversation(t, session, "human-chat-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "human-chat-turn"
	})
	if err := engine.Pause(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	stored, _ := persistence.Message(message.ID)
	if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused || !snapshot.Executor.ConfirmedStopped || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.PauseReason.Value != pauseReasonUser {
		t.Fatal("pausing restricted chat released control or lost its stop receipt")
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationQueuedInputsStayRestrictedAfterReturn(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	first, err := admitReturnedControlInput(t, engine, persistence, "web")
	if err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	acceptConversation(t, session, "first-chat-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "first-chat-turn"
	})
	second, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic second conversational message"})
	if err != nil || !second.Queued || second.Message == nil || second.Message.ID == first.ID || len(engine.Snapshot().PendingFollowups) != 0 {
		t.Fatal("fresh second chat was lost or steered into the earlier turn", err)
	}
	if err := engine.Release(); err != nil {
		t.Fatal(err)
	}
	session.events <- conversationReply("first-chat-turn", "Synthetic first answer")
	session.events <- terminal("first-chat-turn", "completed")
	next := nextConversationSession(t, sessions)
	acceptConversation(t, next, "second-chat-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "second-chat-turn"
	})
	if snapshot := engine.Snapshot(); snapshot.Takeover || !snapshot.Executor.Paused || snapshot.Active.MessageID.Value != second.Message.ID {
		t.Fatal("returning control escalated or replayed a queued restricted message")
	}
	if _, ok := engine.ToolScope(); ok {
		t.Fatal("queued restricted reply gained tool authority")
	}
	next.events <- conversationReply("second-chat-turn", "Synthetic second answer")
	next.events <- terminal("second-chat-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	if len(persistence.Snapshot().Messages) != 4 || len(persistence.Snapshot().WorkTasks) != 0 {
		t.Fatal("queued conversations did not retain separate input and reply identities")
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationUnknownStartIsNeverRetried(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	message, err := admitReturnedControlInput(t, engine, persistence, "web")
	if err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	thread := nextRequest(t, session.fakeWorker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	turn := nextRequest(t, session.fakeWorker, "turn/start")
	turn.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrRequestTimeout, UnknownOutcome: true}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	stored, _ := persistence.Message(message.ID)
	if !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || !engine.Snapshot().Takeover || !engine.Snapshot().Executor.Paused {
		t.Fatal("unconfirmed restricted start was changed into a safe retry")
	}
	receipt, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: message.Text, ClientMessageID: message.ClientMessageID})
	if err != nil || !receipt.Existing || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("retry adopted an unknown conversational request", err)
	}
	select {
	case <-sessions:
		t.Fatal("unknown turn was automatically replayed")
	default:
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationRequiresAnUncontestedSafeAdmission(t *testing.T) {
	for _, scenario := range []string{"acquiring", "reserved", "inherited-stop", "unconfirmed-stop", "thread-opening", "pending-followup", "ordinary-queue", "call", "call-reservation"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, sessions := humanConversationFixture(t)
			engine.mu.Lock()
			switch scenario {
			case "acquiring":
				engine.acquiring = true
			case "reserved":
				engine.computerAcquireReserved = true
			case "inherited-stop":
				engine.inheritedStopFence = true
			case "unconfirmed-stop":
				engine.confirmedStopped = false
			case "thread-opening":
				engine.openingThread = true
			case "pending-followup":
				engine.pendingFollowups["synthetic-other-owner"] = true
			case "ordinary-queue":
				engine.queue = []string{"synthetic-other-owner"}
			case "call":
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "synthetic-call", Provider: "api"}}
			case "call-reservation":
				engine.callReservation = &CallStartReservation{Token: "synthetic-reservation"}
			}
			engine.mu.Unlock()
			message, err := admitReturnedControlInput(t, engine, persistence, "web")
			if err != nil || message == nil {
				t.Fatal(err)
			}
			stored, _ := persistence.Message(message.ID)
			if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || stored.Submission.Value == contracts.SubmissionStatusConfirmed {
				t.Fatal("restricted chat ignored an existing safety owner")
			}
			select {
			case <-sessions:
				t.Fatal("unsafe admission opened a restricted model session")
			default:
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanControlConversationFailureRetainsControlAndUnknownStop(t *testing.T) {
	for _, scenario := range []string{"open-failure", "invalid-thread", "stop-unconfirmed"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, sessions := humanConversationFixture(t)
			if scenario == "open-failure" {
				engine.options.OpenConversation = func(context.Context, string, func() bool) (ConversationSession, error) {
					return nil, runtime.ErrDisconnected
				}
			}
			message, err := admitReturnedControlInput(t, engine, persistence, "web")
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "open-failure" {
				session := nextConversationSession(t, sessions)
				if scenario == "invalid-thread" {
					thread := nextRequest(t, session.fakeWorker, "thread/start")
					thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("")})}}
				} else {
					acceptConversation(t, session, "failed-stop-chat-turn")
					waitSnapshot(t, engine, func(snapshot Snapshot) bool {
						return snapshot.Active != nil && snapshot.Active.TurnID.Value == "failed-stop-chat-turn"
					})
					session.mu.Lock()
					session.stopErr = runtime.ErrStopUnconfirmed
					session.mu.Unlock()
					session.events <- terminal("failed-stop-chat-turn", "completed")
				}
			}
			waitSnapshot(t, engine, func(snapshot Snapshot) bool {
				stored, _ := persistence.Message(message.ID)
				return snapshot.Active == nil && (stored.Status.Value == contracts.MessageStatus(contracts.TaskStatusFailed) || stored.Status.Value == contracts.MessageStatus(contracts.TaskStatusPaused))
			})
			stored, _ := persistence.Message(message.ID)
			if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused {
				t.Fatal("failed restricted connection changed human control")
			}
			if scenario == "stop-unconfirmed" {
				if engine.Snapshot().Executor.ConfirmedStopped || !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown {
					t.Fatal("an unconfirmed process stop was described as safe")
				}
			} else if stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || stored.UnknownOutcome {
				t.Fatal("a known pre-submission failure became a false unknown receipt")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestHumanControlConversationRejectsExistingWorkBinding(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	receipt, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Synthetic work-bound input", ClientMessageID: returnedControlClientID, WorkID: "synthetic-existing-work",
	})
	if err != nil || receipt.Message == nil || receipt.Queued {
		t.Fatal("work-bound input was treated as a fresh ordinary conversation", err)
	}
	select {
	case <-sessions:
		t.Fatal("existing work binding opened a restricted conversation")
	default:
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationRefusesChangedInlineImage(t *testing.T) {
	engine, _, _, _ := humanConversationFixture(t)
	file := contracts.Attachment{ID: "synthetic-image", Name: "synthetic.png", Type: "image/png"}
	for _, scenario := range []string{"wrong-id", "wrong-type", "mismatched-bytes", "read-error", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := t.Context()
			if scenario == "cancelled" {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			engine.options.Attachments = attachmentReaderFunc(func(context.Context, string) (contracts.Attachment, []byte, error) {
				current := file
				data := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1}
				switch scenario {
				case "wrong-id":
					current.ID = "synthetic-replacement"
				case "wrong-type":
					current.Type = "image/jpeg"
				case "mismatched-bytes":
					data = []byte("synthetic non-image")
				case "read-error":
					return current, nil, store.ErrInvalidState
				}
				return current, data, nil
			})
			if _, err := engine.conversationImage(ctx, file); err == nil {
				t.Fatal("unverified image bytes crossed the isolated connection")
			}
		})
	}
}

func TestHumanControlConversationRechecksOwnerBeforeApplyingCapturedReply(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	if _, err := admitReturnedControlInput(t, engine, persistence, "web"); err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	acceptConversation(t, session, "owner-change-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "owner-change-turn"
	})
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	buffered := conversationReply("owner-change-turn", "Synthetic reply from the previous account owner")
	session.mu.Lock()
	session.ownerErr = ErrStaleOwner
	session.mu.Unlock()
	if err := engine.handleConversationEvent(t.Context(), active, buffered); !errors.Is(err, ErrStaleOwner) || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("an in-flight event crossed its original account boundary", err)
	}
	session.mu.Lock()
	session.ownerErr = nil
	session.mu.Unlock()
	session.events <- conversationReply("owner-change-turn", "Synthetic current-owner answer")
	session.events <- terminal("owner-change-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationCannotBeEscalatedByResumingEarlierWork(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	old, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic earlier paused work",
		Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)), TurnID: contracts.Some("retained-paused-turn"),
		Submission: contracts.Some(contracts.SubmissionStatusConfirmed)})
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: old.TurnID.Value, MessageID: old.ID, Source: "chat", Title: "Synthetic old work", Observed: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(t.Context(), old.TurnID.Value, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := admitReturnedControlInput(t, engine, persistence, "web"); err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	acceptConversation(t, session, "no-escalation-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "no-escalation-turn"
	})
	if err := engine.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.ResumePaused(t.Context(), []string{old.ID}, ResumeOptions{}); !errors.Is(err, ErrBusy) {
		t.Fatal("resuming an old message escalated the restricted connection", err)
	}
	if _, err := engine.ResumeProgress(t.Context(), record.ID, store.ProgressWork, old.TurnID.Value); !errors.Is(err, ErrBusy) {
		t.Fatal("resuming old work cleared the restricted connection's pause", err)
	}
	session.events <- conversationReply("no-escalation-turn", "Synthetic conversational answer")
	session.events <- terminal("no-escalation-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	if snapshot := engine.Snapshot(); !snapshot.Executor.Paused || len(snapshot.Queue) != 0 {
		t.Fatal("old work was queued or automatically resumed")
	}
	assertWorkerQuiet(t, worker)
}

func TestHumanControlConversationNewInputAfterUnknownJoinedReplyStaysIndependent(t *testing.T) {
	engine, persistence, worker, sessions := humanConversationFixture(t)
	first, err := admitReturnedControlInput(t, engine, persistence, "web")
	if err != nil {
		t.Fatal(err)
	}
	session := nextConversationSession(t, sessions)
	acceptConversation(t, session, "unknown-disconnect-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "unknown-disconnect-turn"
	})
	session.stopOnce.Do(func() { close(session.events) })
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	unknown, _ := persistence.Message(first.ID)
	before, _ := json.Marshal(unknown)
	if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused || !snapshot.Executor.ConfirmedStopped || !unknown.UnknownOutcome || unknown.Submission.Value != contracts.SubmissionStatusUnknown {
		t.Fatal("joined child and unconfirmed reply were conflated")
	}
	second, err := engine.AdmitMessage(t.Context(), persistence.ConversationID(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic independent new conversational question"})
	if err != nil || !second.Queued || second.Message == nil || second.Message.ID == first.ID {
		t.Fatal("fresh chat inherited the stopped child's disconnected latch", err)
	}
	next := nextConversationSession(t, sessions)
	acceptConversation(t, next, "new-independent-turn")
	next.events <- conversationReply("new-independent-turn", "Synthetic independent answer")
	next.events <- terminal("new-independent-turn", "completed")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	retained, _ := persistence.Message(first.ID)
	after, _ := json.Marshal(retained)
	if string(before) != string(after) || len(persistence.Snapshot().WorkTasks) != 0 {
		t.Fatal("new conversation adopted or rewrote the unknown previous reply")
	}
	if snapshot := engine.Snapshot(); !snapshot.Takeover || !snapshot.Executor.Paused || !snapshot.Executor.ConfirmedStopped {
		t.Fatal("fresh reply released the human desktop lease")
	}
	assertWorkerQuiet(t, worker)
}
