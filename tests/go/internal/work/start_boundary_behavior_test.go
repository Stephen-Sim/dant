package work

import (
	"encoding/json"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestInitialTaskBaselineFailureCannotFallThroughToModelSubmission(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Deliverables = continuationBaselineFailure{}
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Authorized request"})
	if err != nil || engine.Enqueue(t.Context(), message) != nil {
		t.Fatal("fixture input was not admitted", err)
	}
	thread := nextRequest(t, worker, "thread/start")
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && len(snapshot.Queue) == 0 })
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusNotSubmitted || stored.Text != message.Text {
		t.Fatal("known preparation failure invented a submitted or lost task", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestInvalidInitialTurnAcknowledgementRemainsUnknownAndIsNeverRetried(t *testing.T) {
	for _, turn := range []string{`null`, `[]`, `{"id":""}`, `{"id":"bad id"}`, `{"id":"\ud800"}`} {
		t.Run(turn, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Exactly one requested action"})
			if err != nil || engine.Enqueue(t.Context(), message) != nil {
				t.Fatal("fixture input was not admitted", err)
			}
			thread := nextRequest(t, worker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			start := nextRequest(t, worker, "turn/start")
			start.result <- fakeResponse{value: contracts.RawObject{"turn": json.RawMessage(turn)}}
			waitSnapshot(t, engine, func(snapshot Snapshot) bool { return snapshot.Active == nil && snapshot.Executor.Paused })
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.Submission.Value != contracts.SubmissionStatusUnknown || !stored.UnknownOutcome || stored.TurnID.Value != "" || stored.Text != message.Text {
				t.Fatal("malformed acknowledgement invented a known rejection or turn identity", err)
			}
			engine.Wake()
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestModelPreferenceIsCapturedInBothInitialThreadAndExecutionRequests(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error { state.Settings.Model = "fixture-configured-model"; return nil }); err != nil {
		t.Fatal(err)
	}
	message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Current request"})
	if err != nil || engine.Enqueue(t.Context(), message) != nil {
		t.Fatal("fixture input was not admitted", err)
	}
	thread := nextRequest(t, worker, "thread/start")
	if eventString(thread.params, "model") != "fixture-configured-model" {
		t.Fatal("new thread ignored its captured model preference")
	}
	thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
	start := nextRequest(t, worker, "turn/start")
	if eventString(start.params, "model") != "fixture-configured-model" {
		t.Fatal("task start ignored its captured model preference")
	}
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("model-turn")})}}
	waitToolScope(t, engine, "model-turn")
	if err := engine.Handle(t.Context(), terminal("model-turn", "completed")); err != nil {
		t.Fatal(err)
	}
}

func TestCompletedAgentItemWithoutStreamingCreatesOneOwnedFinalMessage(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "complete-only-turn")
	event := runtimeEvent("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("final-output"), "type": raw("agentMessage"), "text": raw("Verified final answer")})}, owner.TurnID)
	for range 2 {
		if err := engine.Handle(t.Context(), event); err != nil {
			t.Fatal(err)
		}
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 2 || state.Messages[1].Text != "Verified final answer" || state.Messages[1].TaskID.Value != message.ID || state.Messages[1].Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) {
		t.Fatal("complete-only output lost its task identity or was delivered twice")
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
}

func TestStreamingAssistantStatusSettlesWithItsActualTerminalOutcome(t *testing.T) {
	for _, status := range []contracts.RuntimeTerminalTurnStatus{contracts.RuntimeTerminalTurnStatusCompleted, contracts.RuntimeTerminalTurnStatusInterrupted} {
		t.Run(string(status), func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "stream-terminal-turn")
			if err := engine.Handle(t.Context(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("stream"), "delta": raw("Partial authored answer")}, owner.TurnID)); err != nil {
				t.Fatal(err)
			}
			if err := engine.Handle(t.Context(), terminal(owner.TurnID, string(status))); err != nil {
				t.Fatal(err)
			}
			state := persistence.Snapshot()
			want := contracts.MessageStatus(contracts.TaskStatusPaused)
			if status == contracts.RuntimeTerminalTurnStatusCompleted {
				want = contracts.MessageStatus(contracts.TaskStatusCompleted)
			}
			if len(state.Messages) != 2 || state.Messages[1].Text != "Partial authored answer" || state.Messages[1].Status.Value != want {
				t.Fatal("streaming message remained live or was falsely completed after interruption")
			}
		})
	}
}
