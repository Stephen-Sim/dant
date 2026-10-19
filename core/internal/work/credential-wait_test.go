package work

import (
	"context"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestCredentialWaitCompletionCannotClearAnotherBlockerOrAReplacementOwner(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "owned work"})
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, "credential-turn")
	waitSnapshot(t, engine, func(snapshot Snapshot) bool {
		return snapshot.Active != nil && snapshot.Active.TurnID.Value == "credential-turn"
	})
	owner, ok := engine.ToolScope()
	if !ok {
		t.Fatal("acknowledged task has no tool owner")
	}
	first, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	first()
	first()
	if engine.Snapshot().Active.Status != contracts.TaskStatusWaitingUser {
		t.Fatal("one credential completion cleared another pending credential")
	}
	second()
	if engine.Snapshot().Active.Status != contracts.TaskStatusRunning {
		t.Fatal("all known blockers ended without restoring running state")
	}
	last, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal("credential-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	last()
	stored, _ := persistence.Message(message.ID)
	if stored.Status.Value == contracts.MessageStatus(contracts.TaskStatusRunning) {
		t.Fatal("late credential completion reopened a retired task")
	}
}
