package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestLocalMutationTransactionsKeepConversationAndToolOwnershipAtomic(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "local-transaction-turn")
	committed := 0
	operation := func(ctx context.Context) error {
		return persistence.Mutate(ctx, func(state *contracts.State) error {
			state.Memory = "owned local mutation"
			committed++
			return nil
		})
	}
	if err := engine.ToolTransaction(context.Background(), owner, operation); err != nil || committed != 1 || persistence.Snapshot().Memory != "owned local mutation" {
		t.Fatal("current tool transaction did not commit its scoped local mutation", err)
	}
	for _, field := range []string{"conversation", "thread", "turn"} {
		stale := owner
		switch field {
		case "conversation":
			stale.ConversationID = "different-conversation"
		case "thread":
			stale.ThreadID = "different-thread"
		case "turn":
			stale.TurnID = "different-turn"
		}
		if err := engine.ToolTransaction(context.Background(), stale, operation); !errors.Is(err, ErrStaleOwner) || committed != 1 {
			t.Fatal("local mutation used a stale captured identity", field, err)
		}
	}
	if err := engine.ToolTransaction(context.Background(), owner, nil); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("nil tool transaction was admitted", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := engine.ToolTransaction(cancelled, owner, operation); !errors.Is(err, context.Canceled) || committed != 1 {
		t.Fatal("cancelled tool transaction committed a mutation", err)
	}
	if err := engine.ConversationTransaction(cancelled, owner.ConversationID, operation); !errors.Is(err, context.Canceled) || committed != 1 {
		t.Fatal("cancelled conversation transaction committed a mutation", err)
	}
	if err := engine.ConversationTransaction(context.Background(), "other-conversation", operation); !errors.Is(err, ErrStaleOwner) || committed != 1 {
		t.Fatal("conversation transaction bypassed its exact identity", err)
	}
	failure := errors.New("isolated_local_write_failure")
	if err := engine.ToolTransaction(context.Background(), owner, func(context.Context) error { return failure }); !errors.Is(err, failure) {
		t.Fatal("local persistence failure was claimed as a successful tool mutation", err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := engine.ToolTransaction(context.Background(), owner, operation); !errors.Is(err, ErrStaleOwner) || committed != 1 {
		t.Fatal("ended tool authority survived into a later local mutation", err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := engine.ToolTransaction(context.Background(), owner, operation); !errors.Is(err, ErrStaleOwner) || committed != 1 {
		t.Fatal("closed engine admitted a tool mutation", err)
	}
	if err := engine.ConversationTransaction(context.Background(), owner.ConversationID, operation); !errors.Is(err, ErrClosed) || committed != 1 {
		t.Fatal("closed engine admitted a conversation mutation", err)
	}
}

func TestPreferencesAllowLivePresentationChangesButReserveProviderChangesForIdle(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "preference-transaction-turn")
	writes := 0
	operation := func(ctx context.Context) error {
		return persistence.Mutate(ctx, func(state *contracts.State) error {
			state.Settings.Language = "ja"
			writes++
			return nil
		})
	}
	if err := engine.PreferenceTransaction(context.Background(), owner.ConversationID, true, operation); !errors.Is(err, ErrBusy) || writes != 0 {
		t.Fatal("provider mutation ran while a task owned execution", err)
	}
	if err := engine.PreferenceTransaction(context.Background(), owner.ConversationID, false, operation); err != nil || writes != 1 || !owner.IsCurrent() {
		t.Fatal("presentation preferences cancelled or bypassed their current task", err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := engine.PreferenceTransaction(context.Background(), owner.ConversationID, true, operation); err != nil || writes != 2 {
		t.Fatal("idle provider transaction was left blocked after the owner ended", err)
	}
	if engine.Store() != persistence {
		t.Fatal("engine exposes a different persistence authority")
	}
	assertWorkerQuiet(t, worker)
}

func TestAPIMediaToolTransactionsUseOnlyTheirCapturedLiveCall(t *testing.T) {
	for _, provider := range []string{"api", "subscription"} {
		t.Run(provider, func(t *testing.T) {
			calls := &admissionCalls{call: contracts.Call{ID: "captured-api-call", Provider: provider}}
			engine, persistence, worker := requestBehaviorFixture(t, Options{Calls: calls})
			owner := ToolContext{CallID: calls.call.ID, ConversationID: persistence.ConversationID()}
			writes := 0
			operation := func(context.Context) error {
				writes++
				return nil
			}
			err := engine.ToolTransaction(context.Background(), owner, operation)
			if provider == "api" && (err != nil || writes != 1) || provider != "api" && (!errors.Is(err, ErrStaleOwner) || writes != 0) {
				t.Fatal("media-only tool transaction borrowed another provider's task authority", err)
			}
			owner.CallID = "replaced-call"
			if err := engine.ToolTransaction(context.Background(), owner, operation); !errors.Is(err, ErrStaleOwner) {
				t.Fatal("stale media identity committed a tool mutation", err)
			}
			assertWorkerQuiet(t, worker.fakeWorker)
		})
	}
}

func TestContextInvalidationRefreshesInstructionsWithoutStartingAnExecution(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	threadID := openNativeBehaviorThread(t, engine, worker)
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		state.Settings.Language = "ko"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	changes, unsubscribe := engine.Subscribe()
	defer unsubscribe()
	engine.InvalidateContext()
	select {
	case <-changes:
	default:
		t.Fatal("context invalidation did not publish a refreshed state")
	}
	result := make(chan error, 1)
	go func() {
		id, err := engine.Thread(context.Background())
		if err == nil && id != threadID {
			err = ErrStaleOwner
		}
		result <- err
	}()
	request := nextRequest(t, worker, "thread/resume")
	if eventString(request.params, "threadId") != threadID || !strings.Contains(eventString(request.params, "developerInstructions"), "Korean") {
		t.Fatal("instruction refresh changed the canonical thread or retained the old language")
	}
	request.result <- fakeResponse{value: contracts.RawObject{}}
	if err := awaitWorkAction(t, result); err != nil || engine.Snapshot().Active != nil || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("context invalidation executed a new task", err)
	}
	if !strings.Contains(engine.Instructions(), "Korean") || engine.OutputDirectory() == "" || engine.CombinedOutput() != "" {
		t.Fatal("public instruction/output projections lost their current scope")
	}
	assertWorkerQuiet(t, worker)
}
