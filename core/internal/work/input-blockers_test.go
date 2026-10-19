package work

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func backgroundFixture(t *testing.T) (*Engine, *execution, *fakeWorker) {
	t.Helper()
	engine, persistence, worker := engineFixture(t)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "unfinished"})
	if err != nil {
		t.Fatal(err)
	}
	if err = engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, "background-turn")
	waitToolScope(t, engine, "background-turn")
	engine.mu.Lock()
	active := engine.active
	active.nativeBackground = true
	engine.mu.Unlock()
	return engine, active, worker
}

func TestBackgroundInputIsPublishedOnceWithoutASubscribedBrowserOrSyntheticAnswer(t *testing.T) {
	engine, active, worker := backgroundFixture(t)
	id, _ := runtime.ParseRPCID(json.RawMessage(`"provider-input"`))
	event := runtime.Event{Method: "item/tool/requestUserInput", ID: contracts.Some(id), Params: contracts.RawObject{"threadId": raw(active.threadID), "turnId": raw(active.turnID), "questions": raw([]contracts.RawObject{{"question": raw("Which workspace should I use?")}})}}
	if err := engine.Handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	response := <-worker.replies
	var object contracts.RawObject
	if json.Unmarshal(response, &object) != nil || string(object["code"]) != "-32601" {
		t.Fatal("background form was answered instead of explicitly rejected", string(response))
	}
	if err := engine.Handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	state := engine.store.Snapshot()
	count := 0
	for _, message := range state.Messages {
		if message.Role == contracts.RoleAssistant && strings.Contains(message.Text, "Which workspace") {
			count++
		}
	}
	if count != 1 || len(engine.pendingRequests) != 0 || engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("background blocker was duplicated, hidden, or retained as an unsupported form")
	}
	if text, permitted := engine.publicationText(active, contracts.TaskStatusCompleted, contracts.TaskStatusReview); permitted || text != "" {
		t.Fatal("terminal notification would publish the same information blocker again")
	}
}

func TestBackgroundCredentialWaitPublishesOneSecureFormNoticeAcrossOverlappingRequests(t *testing.T) {
	engine, active, _ := backgroundFixture(t)
	engine.mu.Lock()
	owner := engine.ownerLocked(active)
	engine.mu.Unlock()
	first, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	state := engine.store.Snapshot()
	count := 0
	for _, message := range state.Messages {
		if message.Role == contracts.RoleAssistant {
			count++
		}
	}
	if count != 1 || engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("overlapping secure requests duplicated or hid the blocker")
	}
	first()
	if engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("first credential completion unblocked a second pending form")
	}
	second()
	if engine.Snapshot().Active.Status != contracts.TaskStatusRunning {
		t.Fatal("final credential completion left a stale blocker")
	}
}
