package work

import (
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestProgressCannotHideOwnersRetainedByQueueFollowupOrMediaAdmission(t *testing.T) {
	for _, retained := range []string{"queued message", "queued turn", "queued work reply", "pending message", "pending turn", "media input"} {
		t.Run(retained, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			original, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Retained synthetic work", TurnID: contracts.Some("progress-retained-turn")})
			if err != nil {
				t.Fatal(err)
			}
			record, err := persistence.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "progress-retained-turn", MessageID: original.ID, Source: "chat", Title: "Retained work", Observed: true})
			if err != nil {
				t.Fatal(err)
			}
			other := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Retained synthetic followup", TurnID: contracts.Some(record.TurnID)}
			if retained == "queued work reply" {
				other.TurnID = contracts.Optional[string]{}
				other.WorkReply = &contracts.WorkReplyTarget{ConversationID: persistence.ConversationID(), WorkID: record.ID, TurnID: record.TurnID}
			}
			followup, err := persistence.Add(t.Context(), other)
			if err != nil {
				t.Fatal(err)
			}
			kind, id := store.ProgressWork, record.ID
			engine.mu.Lock()
			switch retained {
			case "queued message":
				engine.queue = []string{original.ID}
			case "queued turn", "queued work reply":
				engine.queue = []string{followup.ID}
			case "pending message":
				engine.pendingFollowups[original.ID] = true
			case "pending turn":
				engine.pendingFollowups[followup.ID] = true
			case "media input":
				engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "progress-media-call", Provider: "api"}}
				kind, id = store.ProgressTask, original.ID
			}
			engine.mu.Unlock()
			if retained == "media input" {
				if _, err := persistence.Update(t.Context(), original.ID, patch(contracts.RawObject{"voiceCallId": raw("progress-media-call"), "submission": raw(contracts.SubmissionStatusSubmitting)})); err != nil {
					t.Fatal(err)
				}
			}
			if err := engine.DismissProgress(t.Context(), id, kind, store.DismissOptions{ConfirmUnfinished: true}); !errors.Is(err, ErrBusy) {
				t.Fatal("retained progress owner was hidden before its admission settled", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestProgressLookupAndPriorityFailuresLeaveHistoryUnchanged(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	before := persistence.Revision()
	for _, kind := range []store.ProgressKind{store.ProgressTask, store.ProgressWork} {
		if err := engine.DismissProgress(t.Context(), "missing-progress", kind, store.DismissOptions{ConfirmUnfinished: true}); err == nil {
			t.Fatal("missing progress was reported as dismissed")
		}
	}
	if err := engine.SetProgressPriority(t.Context(), "missing-progress", store.ProgressTask, contracts.TaskPriorityHigh); err == nil || persistence.Revision() != before {
		t.Fatal("invalid priority target changed durable history", err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if err := engine.SetProgressPriority(t.Context(), "missing-progress", store.ProgressTask, contracts.TaskPriorityHigh); !errors.Is(err, runtime.ErrBackpressure) {
		t.Fatal("closed engine accepted a progress mutation", err)
	}
	assertWorkerQuiet(t, worker)
}
