package work

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestCredentialWaitCompletionCannotClearAnotherBlockerOrAReplacementOwner(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, _ := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "owned work"})
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, "credential-turn")
	owner := waitToolScope(t, engine, "credential-turn")
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

func TestCredentialScopeRequiresDurablyConfirmedTurnAcknowledgement(t *testing.T) {
	const turnID = "credential-commit-turn"
	commitReached := make(chan struct{})
	commitRelease := make(chan struct{})
	var reached sync.Once
	release := sync.OnceFunc(func() { close(commitRelease) })

	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{
		Write: func(ctx context.Context, name string, data []byte, mode fs.FileMode) error {
			var state contracts.State
			if err := json.Unmarshal(data, &state); err != nil {
				return err
			}
			for _, message := range state.Messages {
				if message.TurnID.Value != turnID || message.Submission.Value != contracts.SubmissionStatusConfirmed {
					continue
				}
				reached.Do(func() { close(commitReached) })
				select {
				case <-commitRelease:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return files.WriteAtomic(ctx, name, data, mode)
		},
	})
	t.Cleanup(release)

	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "owned work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Enqueue(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	acceptThreadAndTurn(t, worker, turnID)
	select {
	case <-commitReached:
	case <-time.After(10 * time.Second):
		t.Fatal("confirmed submission did not reach the controlled persistence boundary")
	}

	snapshot := engine.Snapshot()
	if snapshot.Active == nil || snapshot.Active.TurnID.Value != turnID || snapshot.Active.CanSteer {
		t.Fatal("fixture did not retain the observed but uncommitted turn identity")
	}
	if _, ok := engine.ToolScope(); ok {
		t.Fatal("uncommitted turn acknowledgement granted a tool capability")
	}
	var premature ToolContext
	premature = ToolContext{
		ConversationID: persistence.ConversationID(),
		ThreadID:       "thread-fixture",
		TurnID:         turnID,
	}
	premature.IsCurrent = func() bool { return engine.Current(premature) }
	if _, err := engine.BeginCredentialWait(premature); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("credential wait accepted an uncommitted owner", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Submission.Value != contracts.SubmissionStatusSubmitting {
		t.Fatal("uncommitted acknowledgement changed authoritative message state")
	}

	release()
	owner := waitToolScope(t, engine, turnID)
	finished, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	finished()
	stored, err = persistence.Message(message.ID)
	if err != nil || stored.Submission.Value != contracts.SubmissionStatusConfirmed || stored.TurnID.Value != turnID {
		t.Fatal("admitted credential owner has no durable matching turn acknowledgement")
	}
}
