package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func openNativeBehaviorThread(t *testing.T, engine *Engine, worker *fakeWorker) string {
	t.Helper()
	result := make(chan error, 1)
	var threadID string
	go func() {
		var err error
		threadID, err = engine.Thread(context.Background())
		result <- err
	}()
	request := nextRequest(t, worker, "thread/start")
	request.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	if err := awaitWorkAction(t, result); err != nil || threadID != "thread-fixture" {
		t.Fatal("native thread reference was not independently acknowledged", err)
	}
	return threadID
}

func TestAcknowledgedNativeHandoffHasOneOwnerAndSurvivesMediaDeparture(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	threadID := openNativeBehaviorThread(t, engine, worker)
	input := NativeTurnInput{
		ConversationID: persistence.ConversationID(), CallID: "native-call", ThreadID: threadID,
		TurnID: "native-owned-turn", HandoffID: "native-handoff",
	}
	owner, err := engine.AdoptNativeTurn(context.Background(), input)
	if err != nil || !owner.IsCurrent() || owner.CallID != input.CallID || owner.TurnID != input.TurnID {
		t.Fatal("acknowledged native turn did not receive its exact owner", err)
	}
	again, err := engine.AdoptNativeTurn(context.Background(), input)
	if err != nil || again.TurnID != owner.TurnID || again.CallID != owner.CallID {
		t.Fatal("idempotent native handoff created another execution", err)
	}
	if snapshot := engine.NativeTaskSnapshot(owner); snapshot == nil || snapshot.TurnID.Value != owner.TurnID {
		t.Fatal("native task snapshot lost its admitted owner")
	}
	stale := owner
	stale.ConversationID = "different-conversation"
	if engine.NativeTaskSnapshot(stale) != nil {
		t.Fatal("native task snapshot accepted a foreign conversation")
	}
	if err := engine.ContinueNativeWork(stale); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("a foreign conversation promoted the current native task to background work", err)
	}
	stale = owner
	stale.CallID = "different-call"
	if err := engine.HandleNativeEvent(context.Background(), stale, terminal(owner.TurnID, "completed")); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("an event from another media owner retired the native task", err)
	}
	if err := engine.ContinueNativeWork(owner); err != nil {
		t.Fatal("acknowledged work could not outlive its media session", err)
	}
	assertWorkerQuiet(t, worker)
	event := runtime.Event{Method: "item/completed", Params: contracts.RawObject{
		"threadId": raw(threadID), "turnId": raw(owner.TurnID),
		"item": json.RawMessage(`{"id":"native-result","type":"agentMessage","text":"Verified isolated native result."}`),
	}}
	if err := engine.HandleNativeEvent(context.Background(), owner, event); err != nil {
		t.Fatal(err)
	}
	if len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("native result was copied to chat before its terminal outcome")
	}
	if err := engine.HandleNativeEvent(context.Background(), owner, terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Role != contracts.RoleAssistant || state.Messages[0].Text != "Verified isolated native result." || state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) {
		t.Fatal("departed native media lost or duplicated its accepted background result")
	}
	if engine.NativeTaskSnapshot(owner) != nil || owner.IsCurrent() {
		t.Fatal("completed native execution retained tool authority")
	}
	if _, err := engine.AdoptNativeTurn(context.Background(), input); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("a completed native turn was adopted for replay", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestUnknownNativeSubmissionCannotBePromotedToBackgroundDelivery(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	threadID := openNativeBehaviorThread(t, engine, worker)
	owner, err := engine.AdoptNativeTurn(context.Background(), NativeTurnInput{
		ConversationID: persistence.ConversationID(), CallID: "uncertain-native-call", ThreadID: threadID,
		TurnID: "uncertain-native-turn", HandoffID: "uncertain-native-handoff",
	})
	if err != nil {
		t.Fatal(err)
	}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "isolated native follow-up"})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := engine.Followup(context.Background(), message, owner.TurnID)
		result <- err
	}()
	request := nextRequest(t, worker, "turn/steer")
	request.result <- fakeResponse{err: &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}}
	if err := awaitWorkAction(t, result); err == nil {
		t.Fatal("uncertain native input claimed confirmed admission")
	}
	if err := engine.ContinueNativeWork(owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("uncertain native work acquired background publication permission", err)
	}
	if _, allowed := engine.ToolScope(); allowed {
		t.Fatal("uncertain native work retained tool permission")
	}
	assertWorkerQuiet(t, worker)
	event := runtime.Event{Method: "item/completed", Params: contracts.RawObject{
		"threadId": raw(threadID), "turnId": raw(owner.TurnID),
		"item": json.RawMessage(`{"id":"uncertain-native-result","type":"agentMessage","text":"Unconfirmed fixture result."}`),
	}}
	if err := engine.HandleNativeEvent(context.Background(), owner, event); err != nil {
		t.Fatal(err)
	}
	if err := engine.HandleNativeEvent(context.Background(), owner, terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Role != contracts.RoleUser || !state.Messages[0].UnknownOutcome {
		t.Fatal("unconfirmed native work published a completion or erased its uncertainty")
	}
}

func TestNativeHandoffRejectsUnboundIdentitiesAndForeignMessageReferences(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	threadID := openNativeBehaviorThread(t, engine, worker)
	valid := NativeTurnInput{
		ConversationID: persistence.ConversationID(), CallID: "native-validation-call", ThreadID: threadID,
		TurnID: "native-validation-turn", HandoffID: "native-validation-handoff",
	}
	assistant, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "fixture assistant context"})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*NativeTurnInput){
		func(input *NativeTurnInput) { input.CallID = "" },
		func(input *NativeTurnInput) { input.HandoffID = "invalid identity" },
		func(input *NativeTurnInput) { input.ConversationID = "different-conversation" },
		func(input *NativeTurnInput) { input.ThreadID = "different-thread" },
		func(input *NativeTurnInput) { input.MessageIDs = []string{assistant.ID} },
		func(input *NativeTurnInput) { input.MessageIDs = []string{"missing-message"} },
		func(input *NativeTurnInput) { input.CapturedOwner = &ToolContext{TurnID: "retired-turn"} },
	} {
		input := valid
		change(&input)
		if _, err := engine.AdoptNativeTurn(context.Background(), input); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("unbound native handoff was admitted", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.AdoptNativeTurn(ctx, valid); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled handoff crossed admission", err)
	}
	if engine.Snapshot().Active != nil || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("rejected native handoff changed execution or history")
	}
	assertWorkerQuiet(t, worker)
}

func TestNativePauseWaitsForItsExactTurnAndRejectsForeignOwners(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	threadID := openNativeBehaviorThread(t, engine, worker)
	owner, err := engine.AdoptNativeTurn(context.Background(), NativeTurnInput{
		ConversationID: persistence.ConversationID(), CallID: "native-pause-call", ThreadID: threadID,
		TurnID: "native-pause-turn", HandoffID: "native-pause-handoff",
	})
	if err != nil {
		t.Fatal(err)
	}
	stale := owner
	stale.ConversationID = "other-conversation"
	if err := engine.PauseNativeWork(context.Background(), stale); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("native pause accepted a foreign conversation", err)
	}
	assertWorkerQuiet(t, worker)
	result := make(chan error, 1)
	go func() { result <- engine.PauseNativeWork(context.Background(), owner) }()
	request := nextRequest(t, worker, "turn/interrupt")
	if eventString(request.params, "turnId") != owner.TurnID {
		t.Fatal("native pause interrupted another turn")
	}
	request.result <- fakeResponse{value: contracts.RawObject{}}
	if err := engine.HandleNativeEvent(context.Background(), owner, terminal(owner.TurnID, "interrupted")); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, result); err != nil {
		t.Fatal(err)
	}
	if engine.Snapshot().Active != nil || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("native pause created a completion or retained the stopped task")
	}
	if !errors.Is(engine.ContinueNativeWork(owner), ErrStaleOwner) || !errors.Is(engine.PauseNativeWork(context.Background(), owner), ErrStaleOwner) {
		t.Fatal("a retired native owner resumed or paused another task")
	}
}
