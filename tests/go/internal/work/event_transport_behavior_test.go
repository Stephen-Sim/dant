package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestProviderEventLoopBoundsConcurrentToolsAndStillReceivesInputWhileTheyWait(t *testing.T) {
	entered := make(chan ToolContext, MaxToolWorkers)
	release := make(chan struct{})
	router := workToolRouterFunc(func(ctx context.Context, _ string, _ contracts.RawObject, owner ToolContext) (json.RawMessage, error) {
		entered <- owner
		select {
		case <-release:
			return raw(contracts.RawObject{"accepted": raw(true)}), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	engine, persistence, worker := requestBehaviorFixture(t, Options{ToolRouter: router})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker.fakeWorker, "concurrent-tool-turn")
	for index := range MaxToolWorkers {
		worker.events <- workRequest(t, owner, "item/tool/call", raw(fmt.Sprintf("parallel-tool-%d", index)), contracts.RawObject{"tool": raw("fixture_wait"), "arguments": raw(contracts.RawObject{})})
	}
	for range MaxToolWorkers {
		select {
		case admitted := <-entered:
			if admitted.ConversationID != owner.ConversationID || admitted.TurnID != owner.TurnID || !admitted.IsCurrent() {
				t.Fatal("concurrent tool lost its captured acknowledged task")
			}
		case <-time.After(10 * time.Second):
			t.Fatal("bounded tool worker did not enter the injected I/O boundary")
		}
	}
	excess := workRequest(t, owner, "item/tool/call", raw("excess-tool"), contracts.RawObject{"tool": raw("fixture_wait"), "arguments": raw(contracts.RawObject{})})
	worker.events <- excess
	reply := nextWorkReply(t, worker)
	if reply.id.Key() != excess.ID.Value.Key() || !strings.Contains(string(reply.result), "-32601") {
		t.Fatal("excess tools were not rejected before external dispatch")
	}
	worker.events <- workRequest(t, owner, "item/tool/requestUserInput", raw("parallel-input"), nil)
	waitSnapshot(t, engine, func(state Snapshot) bool {
		return state.Active != nil && state.Active.Status == contracts.TaskStatusWaitingUser
	})
	close(release)
	seen := map[string]bool{}
	for range MaxToolWorkers {
		reply := nextWorkReply(t, worker)
		if seen[reply.id.Key()] || !strings.Contains(string(reply.result), `"success":true`) {
			t.Fatal("concurrent tools lost their separate provider replies")
		}
		seen[reply.id.Key()] = true
	}
	if len(seen) != MaxToolWorkers || len(persistence.Snapshot().Messages) != 1 || engine.Snapshot().Active.TurnID.Value != owner.TurnID {
		t.Fatal("parallel I/O created additional execution owners or chat messages")
	}
}

type tokenUsageBehavior func(context.Context, string, json.RawMessage) (bool, error)

func (observe tokenUsageBehavior) ObserveCodex(ctx context.Context, runtimeID string, params json.RawMessage) (bool, error) {
	return observe(ctx, runtimeID, params)
}

func TestTokenUsageEventsAreThreadScopedAndExposeOnlyBoundedFixedFailureNotices(t *testing.T) {
	for _, oversizeRedaction := range []bool{false, true} {
		t.Run(map[bool]string{false: "fixed-notice", true: "bounded-notice"}[oversizeRedaction], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			threadID := openNativeBehaviorThread(t, engine, worker)
			signals, unsubscribe, err := engine.SubscribeSignals()
			if err != nil {
				t.Fatal(err)
			}
			defer unsubscribe()
			observed := 0
			engine.options.Usage = tokenUsageBehavior(func(_ context.Context, runtimeID string, params json.RawMessage) (bool, error) {
				var event contracts.RawObject
				if runtimeID != worker.RuntimeID() || json.Unmarshal(params, &event) != nil || eventString(event, "threadId") != threadID || string(event["tokenUsage"]) != `{"input":7}` {
					t.Fatal("usage ledger received an unscoped envelope or incorrect runtime")
				}
				observed++
				if observed == 1 {
					return true, nil
				}
				return false, errors.New("fixture-private-usage-error")
			})
			if oversizeRedaction {
				engine.options.Redact = func(_ context.Context, text string) string { return strings.Repeat("x", 1001) }
			}
			event := runtime.Event{Method: "thread/tokenUsage/updated", Params: contracts.RawObject{"threadId": raw(threadID), "tokenUsage": raw(contracts.RawObject{"input": raw(7)})}}
			for range 2 {
				if err := engine.Handle(context.Background(), event); err != nil {
					t.Fatal(err)
				}
			}
			notice := <-signals
			var public struct{ Message string }
			if notice.Type != "notice" || json.Unmarshal(notice.Data, &public) != nil || public.Message == "" || contracts.UTF16Length(public.Message) > 1000 || strings.Contains(public.Message, "fixture-private") {
				t.Fatal("usage persistence failure leaked raw details or an oversized notice")
			}
			event.Params["threadId"] = raw("foreign-thread")
			if err := engine.Handle(context.Background(), event); err != nil || observed != 2 || len(persistence.Snapshot().Messages) != 0 {
				t.Fatal("foreign usage changed the current ledger or created dialogue", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

type mediaEventBehavior struct {
	admissionCalls
	handled int
	err     error
}

func (*mediaEventBehavior) OwnsEvent(event runtime.Event) bool {
	return event.Method == "thread/realtime/fixture"
}

func (calls *mediaEventBehavior) HandleEvent(context.Context, runtime.Event) error {
	calls.handled++
	return calls.err
}

func TestOwnedMediaEventsRemainWithTheCallServiceWithoutCreatingATask(t *testing.T) {
	calls := &mediaEventBehavior{admissionCalls: admissionCalls{call: contracts.Call{ID: "media-event-call", Provider: "api"}}, err: ErrUnknown}
	engine, persistence, worker := requestBehaviorFixture(t, Options{Calls: calls})
	if err := engine.Handle(context.Background(), runtime.Event{Method: "thread/realtime/fixture"}); !errors.Is(err, ErrUnknown) || calls.handled != 1 {
		t.Fatal("media event bypassed its provider or lost an uncertain outcome", err)
	}
	if engine.Snapshot().Active != nil || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("routing a media event created task execution")
	}
	assertWorkerQuiet(t, worker.fakeWorker)
}
