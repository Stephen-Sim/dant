package work

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func waitBehaviorMessageText(t *testing.T, engine *Engine, text string) {
	t.Helper()
	changes, cancel := engine.Store().Subscribe()
	defer cancel()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		for _, message := range engine.Store().Snapshot().Messages {
			if message.Role == contracts.RoleAssistant && message.Text == text {
				return
			}
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("provider output did not reach its expected persisted state")
		}
	}
}

func TestUnacknowledgedEventBuffersEnforceBothTheirByteAndEntryLimits(t *testing.T) {
	for _, byteLimit := range []bool{false, true} {
		t.Run(map[bool]string{false: "entry-limit", true: "byte-limit"}[byteLimit], func(t *testing.T) {
			engine, persistence, worker := requestBehaviorFixture(t, Options{})
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "buffered authorized work"})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("fixture input was not admitted", err)
			}
			thread := nextRequest(t, worker.fakeWorker, "thread/start")
			thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			start := nextRequest(t, worker.fakeWorker, "turn/start")
			owner := ToolContext{ThreadID: "thread-fixture", TurnID: "buffered-acknowledged-turn"}
			expected := ""
			if byteLimit {
				oversize := runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("oversize-event"), "delta": raw(strings.Repeat("x", MaxEarlyBytes+1))}, owner.TurnID)
				if err := engine.Handle(context.Background(), oversize); err != nil {
					t.Fatal(err)
				}
				if err := engine.Handle(context.Background(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("accepted-output"), "delta": raw("accepted bounded output")}, owner.TurnID)); err != nil {
					t.Fatal(err)
				}
				expected = "accepted bounded output"
			} else {
				for range MaxEarlyEvents {
					if err := engine.Handle(context.Background(), runtimeEvent("item/agentMessage/delta", contracts.RawObject{"itemId": raw("accepted-output"), "delta": raw("x")}, owner.TurnID)); err != nil {
						t.Fatal(err)
					}
				}
				excess := workRequest(t, owner, "item/tool/requestUserInput", raw("unacknowledged-excess-form"), nil)
				if err := engine.Handle(context.Background(), excess); err != nil || nextWorkReply(t, worker).id.Key() != excess.ID.Value.Key() {
					t.Fatal("entry-saturated early buffer accepted an additional request", err)
				}
				expected = strings.Repeat("x", MaxEarlyEvents)
			}
			if len(persistence.Snapshot().Messages) != 1 {
				t.Fatal("provider output bound before the start acknowledgement committed")
			}
			start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(owner.TurnID)})}}
			waitToolScope(t, engine, owner.TurnID)
			waitBehaviorMessageText(t, engine, expected)
			if state := persistence.Snapshot(); len(state.Messages) != 2 {
				t.Fatal("discarded early events were replayed as extra chat messages")
			}
			assertWorkerQuiet(t, worker.fakeWorker)
		})
	}
}

func TestObservedExecutionMetadataCanAdvanceProgressWithoutProviderToolContent(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "observed-agent-turn")
	event := runtimeEvent("item/started", contracts.RawObject{"item": raw(contracts.RawObject{"id": raw("observed-provider-item"), "type": raw("agentMessage")})}, owner.TurnID)
	event.TaskExecutionObserved = true
	if err := engine.Handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if engine.Snapshot().Active.Step != contracts.TaskProgressStageResponding || len(state.WorkTasks) != 1 || !state.WorkTasks[0].Provisional {
		t.Fatal("validated execution observation lost its progress or durable task")
	}
	invalid := runtimeEvent("item/started", contracts.RawObject{"item": json.RawMessage(`[]`)}, owner.TurnID)
	if err := engine.Handle(context.Background(), invalid); err != nil || len(persistence.Snapshot().WorkTasks) != 1 {
		t.Fatal("malformed item metadata invented another task", err)
	}
}
