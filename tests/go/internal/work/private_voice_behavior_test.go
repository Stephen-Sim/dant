package work

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestEndingMediaRetiresOnlyItsKnownUnsubmittedPrivateQueueAndPreservesAnActiveTask(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "private-queue-call", Provider: "api"}}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "unrelated-accepted-task")
	done := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(context.Background(), "new voice request awaiting the lane", ToolContext{
			CallID: "private-queue-call", ConversationID: owner.ConversationID, IsCurrent: func() bool { return true },
		})
		done <- err
	}()
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return len(snapshot.Queue) == 1 })
	if err := engine.ContinueVoiceTasks("another-call"); err != nil || len(engine.Snapshot().Queue) != 1 {
		t.Fatal("ending another call retired this call's queued request", err)
	}
	if err := engine.ContinueVoiceTasks("private-queue-call"); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); !errors.Is(err, ErrPaused) {
		t.Fatal("known unsubmitted private work remained executing after its media ended", err)
	}
	if err := engine.ContinueVoiceTasks("private-queue-call"); err != nil {
		t.Fatal("idempotent media-end reconciliation changed an already retired queue", err)
	}
	if state := engine.Snapshot(); state.Active == nil || state.Active.TurnID.Value != owner.TurnID || len(state.Queue) != 0 || !owner.IsCurrent() {
		t.Fatal("retiring private queued input cancelled unrelated accepted work")
	}
	if len(persistence.Snapshot().Messages) != 1 || unconfirmedVoiceTasks(persistence.Snapshot()) {
		t.Fatal("private queue retirement leaked speech into chat or retained a false sent fence")
	}
	assertWorkerQuiet(t, worker)
}

func TestPrivateVoicePreparationCanBeRetiredBeforeAnyTaskStartWasSubmitted(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "preparing-private-call", Provider: "api"}}
	done := make(chan error, 1)
	go func() {
		_, err := engine.RunVoiceTask(context.Background(), "authorized but not submitted", ToolContext{CallID: "preparing-private-call", IsCurrent: func() bool { return true }})
		done <- err
	}()
	_ = nextRequest(t, worker, "thread/start")
	if err := engine.ContinueVoiceTasks("preparing-private-call"); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); !errors.Is(err, ErrPaused) {
		t.Fatal("retired pre-submit media work was reported as an accepted task", err)
	}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil })
	if unconfirmedVoiceTasks(persistence.Snapshot()) || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("known pre-submit cancellation left a private action uncertainty or chat transcript")
	}
	assertWorkerQuiet(t, worker)
}

func TestPrivateVoiceOutputReturnsToItsWaiterWithoutCopyingSpeechIntoChat(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "live-private-call", Provider: "api"}}
	done := make(chan error, 1)
	var result json.RawMessage
	go func() {
		var err error
		result, err = engine.RunVoiceTask(context.Background(), "return the requested result", ToolContext{CallID: "live-private-call", IsCurrent: func() bool { return true }})
		done <- err
	}()
	acceptThreadAndTurn(t, worker, "live-private-turn")
	owner := waitToolScope(t, engine, "live-private-turn")
	event := runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("private-output"), "type": raw("agentMessage"), "text": raw("Verified private speech result.")})}, owner.TurnID)
	if err := engine.Handle(context.Background(), event); err != nil || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("private media result was copied into visible chat before delivery", err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := awaitWorkAction(t, done); err != nil {
		t.Fatal(err)
	}
	var response struct{ Result string }
	if json.Unmarshal(result, &response) != nil || response.Result != "Verified private speech result." || len(persistence.Snapshot().Messages) != 0 || unconfirmedVoiceTasks(persistence.Snapshot()) {
		t.Fatal("private voice completion lost its exact result or retained an execution fence")
	}
	assertWorkerQuiet(t, worker)
}

func TestPrivateVoiceAdmissionValidatesCurrentMediaAndItsDurableFenceCapacity(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "private-validation-call", Provider: "api"}}
	for _, owner := range []ToolContext{
		{},
		{CallID: "private-validation-call"},
		{CallID: "private-validation-call", IsCurrent: func() bool { return false }},
		{CallID: "wrong-call", IsCurrent: func() bool { return true }},
		{CallID: "private-validation-call", ConversationID: "wrong-conversation", IsCurrent: func() bool { return true }},
	} {
		if _, err := engine.RunVoiceTask(context.Background(), "isolated voice work", owner); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("invalid media authority admitted private work", err)
		}
	}
	owner := ToolContext{CallID: "private-validation-call", IsCurrent: func() bool { return true }}
	if _, err := engine.RunVoiceTask(context.Background(), " \t", owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("blank private input created an execution", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.RunVoiceTask(ctx, "cancelled input", owner); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled media request was admitted", err)
	}
	for _, malformed := range []bool{false, true} {
		if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
			if malformed {
				state.Extra[voiceTaskFenceKey] = raw(true)
			} else {
				fences := make([]voiceTaskFence, store.MaxWorkRecords)
				for index := range fences {
					fences[index] = voiceTaskFence{ID: "earlier-private-owner", Submission: contracts.SubmissionStatusNotSubmitted}
				}
				state.Extra[voiceTaskFenceKey] = raw(fences)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		_, err := engine.RunVoiceTask(context.Background(), "new private input", owner)
		if malformed && !errors.Is(err, store.ErrInvalidState) || !malformed && !errors.Is(err, runtime.ErrBackpressure) {
			t.Fatal("invalid or saturated private execution fence accepted new work", err)
		}
	}
	if len(persistence.Snapshot().Messages) != 0 || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("rejected private work created chat or executable queued input")
	}
	assertWorkerQuiet(t, worker)
}
