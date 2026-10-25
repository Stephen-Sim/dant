package work

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

// Historical records are synthetic projections of supported legacy ownership.
// All execution requests use the existing in-memory fake Worker.
func TestSelectedKnownProgressResumePreservesUnrelatedHistoricalUncertainty(t *testing.T) {
	for _, sample := range []struct {
		name     string
		count    int
		detached bool
	}{
		{name: "control-no-historical-unknowns"},
		{name: "two-historical-orphans", count: 2},
		{name: "two-detached-confirmed-unknowns-matching-actual-metadata", count: 2, detached: true},
	} {
		unknownCount := sample.count
		t.Run(sample.name, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			ids := []string{}
			for index := 0; index < unknownCount; index++ {
				input := &contracts.ChatMessage{
					Role: contracts.RoleUser, Text: "historical-unknown-marker-do-not-replay",
					Time: contracts.Some(float64(1)), ReceivedAt: contracts.Some(float64(1)),
					Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusUnknown)),
					Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
					ExecutionEndedAt: contracts.Null[float64](),
				}
				if sample.detached {
					input.TurnID = contracts.Some(fmt.Sprintf("detached-old-turn-%d", index))
					input.QueuedAt = contracts.Some(float64(2))
					input.ExecutorConfirmedAt = contracts.Some(float64(3))
					input.PauseReason = contracts.Some("executor-disconnected")
					if index == 0 {
						input.ReceivedAt = contracts.Null[float64]()
						input.Source = contracts.RawObject{
							"type": raw("telegram"), "botId": raw("12345"), "chatId": raw("67890"),
							"userId": raw("67890"), "pairingId": raw(strings.Repeat("a", 32)),
							"updateId": raw(19), "messageId": raw("42"),
						}
					} else {
						input.WorkKind = "conversation"
					}
				}
				message, err := persistence.Add(t.Context(), input)
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, message.ID)
			}
			oldWorkIDs := []string{}
			if sample.detached {
				for index := 0; index < 2; index++ {
					id := store.UUID()
					oldWorkIDs = append(oldWorkIDs, id)
					if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
						state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{
							ID: id, TurnID: "detached-old-turn-0", TurnIDs: []string{"detached-old-turn-0"},
							Title: "older known paused synthetic work", Source: "chat", Status: contracts.WorkStatusPaused,
							MessageID: contracts.Null[string](), StartedAt: 1, UpdatedAt: 5, ExecutionEndedAt: contracts.Some(float64(5)), Provisional: true,
						})
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				}
			}
			unknownBytes := func() string {
				messages := []*contracts.ChatMessage{}
				for _, id := range ids {
					message, err := persistence.Message(id)
					if err != nil {
						t.Fatal(err)
					}
					messages = append(messages, message)
				}
				oldWorks := []contracts.WorkRecord{}
				for _, record := range persistence.Snapshot().WorkTasks {
					if slices.Contains(oldWorkIDs, record.ID) {
						oldWorks = append(oldWorks, record)
					}
				}
				encoded, err := json.Marshal(struct {
					Messages []*contracts.ChatMessage
					Works    []contracts.WorkRecord
				}{messages, oldWorks})
				if err != nil {
					t.Fatal(err)
				}
				return string(encoded)
			}
			original := unknownBytes()
			_, owner := beginBehaviorTurn(t, engine, persistence, worker, "fresh-confirmed-selected-turn")
			registered, err := engine.Tool(t.Context(), "task_plan", contracts.RawObject{
				"title": raw("fresh selected harmless work"),
				"steps": json.RawMessage(`[{"step":"produce synthetic final result","status":"pending"}]`),
			}, owner)
			if err != nil {
				t.Fatal(err)
			}
			var record struct {
				WorkID string `json:"workId"`
			}
			if json.Unmarshal(registered, &record) != nil || record.WorkID == "" {
				t.Fatal("fresh confirmed turn did not register its own work")
			}
			paused := make(chan error, 1)
			go func() {
				_, err := engine.CancelProgress(context.Background(), ProgressTarget{ID: record.WorkID,
					Kind: "work", TurnID: contracts.Some(owner.TurnID), ConversationID: owner.ConversationID}, true)
				paused <- err
			}()
			interrupt := nextRequest(t, worker, "turn/interrupt")
			if eventString(interrupt.params, "turnId") != owner.TurnID {
				t.Fatal("pause did not target the exact fresh owner")
			}
			interrupt.result <- fakeResponse{value: contracts.RawObject{}}
			if err := engine.Handle(t.Context(), terminal(owner.TurnID, "interrupted")); err != nil {
				t.Fatal(err)
			}
			if err := awaitWorkAction(t, paused); err != nil {
				t.Fatal(err)
			}
			if engine.Snapshot().Active != nil || !engine.Snapshot().Executor.ConfirmedStopped {
				t.Fatal("selected turn was not positively stopped")
			}
			if unknownCount != 0 && engine.CanContinueRegisteredWork() {
				t.Fatal("historical unknowns lost the global automatic barrier")
			}
			done := make(chan error, 1)
			go func() {
				_, err := engine.ResumeProgress(t.Context(), record.WorkID, store.ProgressWork, owner.TurnID)
				done <- err
			}()
			var request fakeRequest
			select {
			case request = <-worker.requests:
			case err := <-done:
				t.Fatalf("explicit selection failed before thread validation: %v", err)
			case <-time.After(10 * time.Second):
				t.Fatal("explicit selection did not validate its thread")
			}
			if request.method == "thread/resume" {
				request.result <- fakeResponse{value: contracts.RawObject{}}
				request = nextRequest(t, worker, "thread/read")
			}
			if request.method != "thread/read" || eventString(request.params, "threadId") != owner.ThreadID {
				t.Fatal("resume did not validate the current registered thread", request.method)
			}
			request.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[{"id":"fresh-confirmed-selected-turn","status":"interrupted"}]}`)}}
			start := nextRequest(t, worker, "turn/start")
			if strings.Contains(string(start.params["input"]), "historical-unknown-marker") || !strings.Contains(string(start.params["input"]), record.WorkID) || !strings.Contains(string(start.params["input"]), "human explicitly selected Resume") || strings.Contains(string(start.params["input"]), "Automatic follow-up") {
				t.Fatal("selected continuation adopted an unrelated request")
			}
			start.result <- fakeResponse{value: contracts.RawObject{"turn": json.RawMessage(`{"id":"fresh-resumed-turn"}`)}}
			if err := awaitWorkAction(t, done); err != nil {
				t.Fatal(err)
			}
			if original != unknownBytes() {
				t.Fatal("dispatch changed historical unknown outcomes")
			}
			if err := engine.Handle(t.Context(), terminal("fresh-resumed-turn", "completed")); err != nil {
				t.Fatal(err)
			}
		})
	}
}
