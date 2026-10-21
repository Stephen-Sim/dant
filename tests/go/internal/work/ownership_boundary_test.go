package work

import (
	"errors"
	"slices"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestHistoryTransactionsCaptureActiveOwnershipAndChangeOnlyTheSelectedQueueIDs(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "history-owner-turn")
	queued, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Queued request"})
	if err != nil || engine.Enqueue(t.Context(), queued) != nil {
		t.Fatal("fixture queue could not be populated", err)
	}
	if err := engine.HistoryTransaction(t.Context(), func(ownership history.Ownership) (history.QueueChange, error) {
		if !slices.Equal(ownership.ActiveIDs, []string{message.ID}) || !slices.Equal(ownership.Queue, []string{queued.ID}) {
			t.Fatal("history transaction did not capture the active and queued owners")
		}
		ownership.ActiveIDs[0] = "caller mutation"
		return history.QueueChange{WithdrawID: queued.ID}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(engine.Snapshot().Queue) != 0 || engine.Snapshot().Active.MessageID.Value != owner.MessageID {
		t.Fatal("history withdrawal changed active ownership or retained the selected ID")
	}
	for range 2 {
		if err := engine.HistoryTransaction(t.Context(), func(history.Ownership) (history.QueueChange, error) {
			return history.QueueChange{EnqueueID: queued.ID}, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(engine.Snapshot().Queue, []string{queued.ID}) {
		t.Fatal("history enqueue duplicated the same saved identity")
	}
	if err := engine.HistoryTransaction(t.Context(), func(history.Ownership) (history.QueueChange, error) { return history.QueueChange{Clear: true}, nil }); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := engine.HistoryTransaction(t.Context(), func(history.Ownership) (history.QueueChange, error) {
		t.Fatal("closed engine reached history mutation")
		return history.QueueChange{}, nil
	}); !errors.Is(err, ErrClosed) {
		t.Fatal("closed history transaction was accepted", err)
	}
}

func TestPumpDropsMissingQueueReferencesAndKeepsScheduledMediaOrUnknownWorkBlocked(t *testing.T) {
	for _, kind := range []string{"missing reference", "scheduled media", "subscription media", "unknown work", "unknown private voice"} {
		t.Run(kind, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			engine.mu.Lock()
			engine.paused = true
			engine.mu.Unlock()
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "queued", Role: contracts.RoleUser, Text: "Retained request", Scheduled: kind == "scheduled media"})
			if err != nil {
				t.Fatal(err)
			}
			if kind == "unknown work" || kind == "unknown private voice" {
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					if kind == "unknown work" {
						state.WorkTasks = []contracts.WorkRecord{{ID: "6cfd1cbe-38c9-4225-b8c2-c56b681c8130", TurnID: "previous", TurnIDs: []string{"previous"}, Source: "chat", Title: "Unconfirmed work", Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "Check result", Status: contracts.PlanStepStatusPending}}, Total: 1}, Status: contracts.WorkStatusPaused, UnknownOutcome: true}}
					} else {
						state.Extra[voiceTaskFenceKey] = raw([]voiceTaskFence{{ID: "private", CallID: "call", ConversationID: state.ConversationID, Submission: contracts.SubmissionStatusUnknown}})
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			engine.mu.Lock()
			engine.queue = []string{message.ID}
			if kind == "missing reference" {
				engine.queue = []string{"deleted-message"}
			}
			if kind == "scheduled media" {
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "api"}}
			} else if kind == "subscription media" {
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "call", Provider: "subscription"}}
			}
			engine.paused = false
			engine.mu.Unlock()
			engine.pump()
			if snapshot := engine.Snapshot(); snapshot.Active != nil || kind == "missing reference" && len(snapshot.Queue) != 0 || kind != "missing reference" && !slices.Equal(snapshot.Queue, []string{message.ID}) {
				t.Fatal("pump discarded blocked work or admitted an unconfirmed execution", kind)
			}
			engine.mu.Lock()
			engine.paused = true
			engine.mu.Unlock()
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestUnconfirmedStateIncludesMalformedPrivateFencesWithoutInventingSafeReplay(t *testing.T) {
	oversized := make([]voiceTaskFence, store.MaxWorkRecords+1)
	for index := range oversized {
		oversized[index].Submission = contracts.SubmissionStatusNotSubmitted
	}
	for _, state := range []contracts.State{
		{Extra: contracts.RawObject{voiceTaskFenceKey: []byte(`null`)}},
		{Extra: contracts.RawObject{voiceTaskFenceKey: []byte(`{}`)}},
		{Extra: contracts.RawObject{voiceTaskFenceKey: raw(oversized)}},
	} {
		// A JSON null represents the supported empty legacy list. Other
		// malformed or oversized shapes must retain the uncertainty fence.
		want := string(state.Extra[voiceTaskFenceKey]) != "null"
		if unconfirmedState(state) != want {
			t.Fatal("private submission fence changed uncertainty semantics")
		}
	}
	state := contracts.State{}
	if err := setVoiceTaskFence(&state, voiceTaskFence{ID: "private", CallID: "call", Submission: contracts.SubmissionStatusNotSubmitted}, false); err != nil || state.Extra == nil || unconfirmedState(state) {
		t.Fatal("known unsent private input acquired an execution confirmation", err)
	}
	if err := setVoiceTaskFence(&state, voiceTaskFence{ID: "private"}, true); err != nil || unconfirmedState(state) {
		t.Fatal("retired private fence remained eligible for execution", err)
	}
}
