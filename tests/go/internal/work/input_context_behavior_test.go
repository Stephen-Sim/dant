package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestExplicitHumanWorkReplyRetainsCompletedStepsAndNeverReplaysTheOriginalRequest(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	original, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "previous authorized request"})
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(context.Background(), store.RegisterWorkOptions{
		TurnID: "finished-prior-turn", MessageID: original.ID, Source: "chat", Title: "completed entrusted work",
		Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "preserve this verified side effect", Status: contracts.PlanStepStatusCompleted}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(context.Background(), record.TurnID, store.UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusCompleted), ExecutionEnded: true, At: engine.Timestamp(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		state.ThreadID, state.ThreadRuntime = contracts.Some("thread-fixture"), contracts.Some(worker.RuntimeID())
		state.ThreadConversationID = state.ConversationID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "make only this new adjustment", ReplyTo: contracts.Some(original.ID), WorkID: record.ID,
		WorkReply: &contracts.WorkReplyTarget{WorkID: record.ID, TurnID: record.TurnID, ConversationID: persistence.ConversationID()},
	})
	if err != nil {
		t.Fatal(err)
	}
	references := 0
	engine.options.Memory = ReferenceMemoryFunc(func(_ context.Context, query, conversationID, workID string) (string, error) {
		references++
		if query != message.Text || conversationID != persistence.ConversationID() || workID != record.ID {
			t.Fatal("human adjustment memory query escaped the captured task scope")
		}
		return "isolated relevant reference", nil
	})
	done := make(chan error, 1)
	go func() {
		_, err := engine.ContinueRegisteredWork(context.Background(), record.ID, ContinueOptions{ExpectedTurnID: record.TurnID, Message: message})
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	read := nextRequest(t, worker, "thread/read")
	replyContinuationInventory(t, worker, read, continuationBehaviorThread(record.TurnID))
	start := nextRequest(t, worker, "turn/start")
	var input []struct{ Text string }
	if json.Unmarshal(start.params["input"], &input) != nil || len(input) != 1 {
		t.Fatal("human work reply lost its bounded text input envelope")
	}
	for _, required := range []string{
		"only this NEW human message authorizes reopening", "never replay the original task", "preserve this verified side effect",
		"make only this new adjustment", "Replying to: previous authorized request", "isolated relevant reference", record.ID, message.ID,
	} {
		if !strings.Contains(input[0].Text, required) {
			t.Fatal("human adjustment lost an ownership, reference or no-replay boundary", required)
		}
	}
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("human-adjustment-turn")})}}
	if err := awaitWorkAction(t, done); err != nil {
		t.Fatal(err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Submission.Value != contracts.SubmissionStatusConfirmed || stored.TurnID.Value != "human-adjustment-turn" || references != 1 {
		t.Fatal("human reply did not persist its one acknowledged continuation", err)
	}
	owner := waitToolScope(t, engine, "human-adjustment-turn")
	arguments := behaviorPlan("completed entrusted work", contracts.PlanStepStatusCompleted)
	arguments["workId"] = raw(record.ID)
	if _, err := engine.Tool(context.Background(), "task_plan", arguments, owner); err != nil {
		t.Fatal("explicit new human authorization could not update its own bound task", err)
	}
	if _, err := engine.DeliverText(context.Background(), "Only the new adjustment is complete.", owner); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	updated, err := store.FindWork(&state, record.ID)
	if err != nil || len(state.WorkTasks) != 1 || updated.Status != contracts.WorkStatusReview || len(state.Messages) != 3 || state.Messages[2].Text != "Only the new adjustment is complete." {
		t.Fatal("human adjustment created a replacement task or duplicated earlier work", err)
	}
}

func TestMemoryReferenceValidatesExplicitTaskScopeBeforeCallingTheMemoryProvider(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, turnID := savedUnfinished(t, persistence)
	lookups := 0
	failure := errors.New("isolated_reference_failure")
	engine.options.Memory = ReferenceMemoryFunc(func(_ context.Context, query, conversationID, id string) (string, error) {
		lookups++
		if query != "current request" || conversationID != persistence.ConversationID() || id != workID {
			t.Fatal("memory retrieval used a different request or scope")
		}
		return "", failure
	})
	message := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "current request", WorkReply: &contracts.WorkReplyTarget{
		WorkID: workID, TurnID: turnID, ConversationID: persistence.ConversationID(),
	}}
	if _, err := engine.MemoryReference(context.Background(), message, "", message.Text); !errors.Is(err, failure) || lookups != 1 {
		t.Fatal("valid scoped retrieval lost its classified storage failure", err)
	}
	for _, input := range []struct {
		message *contracts.ChatMessage
		workID  string
	}{
		{nil, workID},
		{message, "other-work"},
		{&contracts.ChatMessage{WorkReply: &contracts.WorkReplyTarget{WorkID: workID, ConversationID: "other-conversation"}}, ""},
		{&contracts.ChatMessage{}, "missing-work"},
	} {
		if _, err := engine.MemoryReference(context.Background(), input.message, input.workID, "invalid request"); err == nil || lookups != 1 {
			t.Fatal("invalid scope reached memory retrieval or returned authority", err)
		}
	}
	assertWorkerQuiet(t, worker)
}
