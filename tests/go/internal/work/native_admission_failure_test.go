package work

import (
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestNativeAdoptionCannotReplaceAnActiveOrCapturedExecutionOwner(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "captured-native-admission")
	before := persistence.Revision()
	input := NativeTurnInput{
		ConversationID: owner.ConversationID, CallID: "candidate-call", ThreadID: owner.ThreadID,
		TurnID: owner.TurnID, HandoffID: "candidate-handoff",
	}
	foreign := input
	foreign.TurnID = "different-active-turn"
	if _, err := engine.AdoptNativeTurn(t.Context(), foreign); !errors.Is(err, ErrBusy) {
		t.Fatal("native handoff replaced independently acknowledged active execution", err)
	}
	captured := owner
	captured.ThreadID = "retired-captured-thread"
	input.CapturedOwner = &captured
	if _, err := engine.AdoptNativeTurn(t.Context(), input); !errors.Is(err, ErrStaleOwner) || persistence.Revision() != before || !owner.IsCurrent() {
		t.Fatal("changed captured owner was admitted or altered the active task", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestNativeAdoptionCannotInventAnOwnerForUncertainStateOrForeignSavedInputs(t *testing.T) {
	for _, scenario := range []string{"unknown saved work", "retired captured owner", "missing input", "assistant input"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			thread := openNativeBehaviorThread(t, engine, worker)
			input := NativeTurnInput{
				ConversationID: persistence.ConversationID(), CallID: "new-native-call", ThreadID: thread,
				TurnID: "new-native-turn", HandoffID: "new-native-handoff",
			}
			want := ErrStaleOwner
			switch scenario {
			case "unknown saved work":
				workID, fromTurn := savedUnfinished(t, persistence)
				if _, err := persistence.UpdateRegisteredWork(t.Context(), fromTurn, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusUnknown)}); err != nil {
					t.Fatal(workID, err)
				}
				want = ErrUnknown
			case "retired captured owner":
				input.CapturedOwner = &ToolContext{TurnID: "retired-turn"}
			case "missing input":
				input.MessageIDs = []string{"missing-input"}
			case "assistant input":
				message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "Existing result"})
				if err != nil {
					t.Fatal(err)
				}
				input.MessageIDs = []string{message.ID}
			}
			before := persistence.Revision()
			if _, err := engine.AdoptNativeTurn(t.Context(), input); !errors.Is(err, want) || persistence.Revision() != before || engine.Snapshot().Active != nil {
				t.Fatal("unverified native handoff invented execution authority", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestCancellationRejectsChangedMediaAndRetiredTaskBindings(t *testing.T) {
	for _, scenario := range []string{"foreign media", "changed task turn", "unknown active owner"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			message, owner := beginBehaviorTurn(t, engine, persistence, worker, "cancel-owner-boundary")
			target := ProgressTarget{ID: message.ID, Kind: "task", TurnID: contracts.Some(owner.TurnID), ConversationID: owner.ConversationID}
			want := ErrStaleOwner
			switch scenario {
			case "foreign media":
				target.CallID = contracts.Some("foreign-media-call")
			case "changed task turn":
				if _, err := persistence.Update(t.Context(), message.ID, contracts.MessagePatch{"turnId": raw("replacement-message-turn")}); err != nil {
					t.Fatal(err)
				}
				target.TurnID = contracts.Some("replacement-message-turn")
			case "unknown active owner":
				engine.mu.Lock()
				engine.active.unknown = true
				engine.mu.Unlock()
				want = ErrUnknown
			}
			before := persistence.Revision()
			if _, err := engine.CancelProgress(t.Context(), target, false); !errors.Is(err, want) || persistence.Revision() != before || engine.Snapshot().Active == nil {
				t.Fatal("stale cancellation modified or interrupted another execution owner", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
