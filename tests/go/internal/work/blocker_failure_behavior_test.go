package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestBackgroundQuestionsAreBoundedSanitizedAndNeverAnsweredByInventedInput(t *testing.T) {
	engine, active, worker := backgroundFixture(t)
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-secret", "[redacted]")
	}
	questions := []contracts.RawObject{{"question": raw(3)}, {"question": raw("")}, {"question": raw("fixture-secret " + strings.Repeat("😀", 3000))}}
	for index := range 8 {
		questions = append(questions, contracts.RawObject{"question": raw(fmt.Sprintf("bounded question %d", index))})
	}
	id, _ := runtime.ParseRPCID(raw("rich-background-form"))
	event := runtimeEvent("item/tool/requestUserInput", contracts.RawObject{"questions": raw(questions)}, active.turnID)
	event.ID = contracts.Some(id)
	if err := engine.Handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	state := engine.Store().Snapshot()
	if len(state.Messages) != 2 || strings.Contains(state.Messages[1].Text, "fixture-secret") || !strings.Contains(state.Messages[1].Text, "[redacted]") || strings.Contains(state.Messages[1].Text, "bounded question 5") || contracts.UTF16Length(state.Messages[1].Text) > 6000 {
		t.Fatal("background form exposed secrets, exceeded its text bounds or included excess questions")
	}
	var rejection struct{ Code int }
	if json.Unmarshal(<-worker.replies, &rejection) != nil || rejection.Code != -32601 {
		t.Fatal("background form generated a synthetic human answer")
	}
	for index := 1; index < maxPendingUserRequests; index++ {
		id, _ := runtime.ParseRPCID(raw(fmt.Sprintf("background-form-%d", index)))
		event.ID = contracts.Some(id)
		if err := engine.Handle(context.Background(), event); err != nil {
			t.Fatal(err)
		}
		<-worker.replies
	}
	last, _ := runtime.ParseRPCID(raw("excess-background-form"))
	event.ID = contracts.Some(last)
	if err := engine.Handle(context.Background(), event); err != nil || !strings.Contains(string(<-worker.replies), "input request limit") {
		t.Fatal("background forms exceeded their bounded identity registry", err)
	}
	if len(engine.Store().Snapshot().Messages) != 2 || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("duplicate question text flooded chat or started another execution")
	}
}

func TestCredentialWaitingSaveFailureRollsBackOnlyItsOwnBlocker(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool {
		return len(state.Messages) > 0 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusWaitingUser)
	}}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "credential-save-failure-turn")
	fault.armed.Store(true)
	if _, err := engine.BeginCredentialWait(owner); !errors.Is(err, store.ErrPersistence) {
		t.Fatal("failed waiting-state write claimed a credential blocker", err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) || engine.Snapshot().Active.Status != contracts.TaskStatusRunning || !owner.IsCurrent() {
		t.Fatal("failed credential state retained a phantom blocker or retired current authority", err)
	}
	finish, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	finish()
	if engine.Snapshot().Active.Status != contracts.TaskStatusRunning {
		t.Fatal("later independent credential completion inherited a failed blocker's count")
	}
	assertWorkerQuiet(t, worker)
}

func TestCredentialCompletionPersistenceFailureProducesAFixedNoticeWithoutAnExternalRetry(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool {
		return len(state.Messages) > 0 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusRunning)
	}}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "credential-completion-failure-turn")
	finish, err := engine.BeginCredentialWait(owner)
	if err != nil {
		t.Fatal(err)
	}
	signals, unsubscribe, err := engine.SubscribeSignals()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	fault.armed.Store(true)
	finish()
	signal := <-signals
	if signal.Type != "notice" || !strings.Contains(string(signal.Data), "waiting state could not be saved") || fault.failures.Load() != 1 {
		t.Fatal("credential completion write failure was hidden or leaked a raw storage error")
	}
	finish()
	select {
	case <-signals:
		t.Fatal("repeated completion automatically retried or emitted a duplicate failure")
	default:
	}
	assertWorkerQuiet(t, worker)
}

func TestCredentialWaitAcceptsOnlyTheExactAPIMediaOwnerWithoutABackingTask(t *testing.T) {
	for _, provider := range []string{"api", "subscription"} {
		t.Run(provider, func(t *testing.T) {
			engine, persistence, worker := requestBehaviorFixture(t, Options{Calls: &admissionCalls{call: contracts.Call{ID: "media-credential-call", Provider: provider}}})
			owner := ToolContext{CallID: "media-credential-call", IsCurrent: func() bool { return true }}
			finish, err := engine.BeginCredentialWait(owner)
			if provider == "api" {
				if err != nil || finish == nil {
					t.Fatal("exact API media owner could not await its own secure form", err)
				}
				finish()
				finish()
			} else if !errors.Is(err, ErrStaleOwner) {
				t.Fatal("native media borrowed API-only credential authority", err)
			}
			owner.CallID = "old-call"
			if _, err := engine.BeginCredentialWait(owner); !errors.Is(err, ErrStaleOwner) {
				t.Fatal("credential form was rebound to a replacement media session", err)
			}
			if len(persistence.Snapshot().Messages) != 0 || engine.Snapshot().Active != nil {
				t.Fatal("waiting for a media credential created a task or transcript")
			}
			assertWorkerQuiet(t, worker.fakeWorker)
		})
	}
}
