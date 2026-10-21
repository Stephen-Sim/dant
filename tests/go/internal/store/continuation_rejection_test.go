package store

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func rejectedContinuationFixture(t *testing.T) (*Store, string, string, RejectedContinuationStart) {
	t.Helper()
	directory := t.TempDir()
	persistence, err := Open(directory, Options{Now: func() time.Time { return time.UnixMilli(20000) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(persistence.Close)
	record, err := persistence.RegisterWork(t.Context(), RegisterWorkOptions{
		TurnID: "previous-safe-turn", Source: "chat", Title: "unfinished isolated work", Observed: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(t.Context(), record.TurnID, UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusContinuing), ExecutionEnded: true, At: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	proof := RejectedContinuationStart{
		ConversationID: persistence.ConversationID(), FromTurnID: record.TurnID,
		RuntimeID: "vm:rejection-fixture", ThreadID: "rejection-fixture-thread",
	}
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
		state.ThreadID, state.ThreadRuntime = contracts.Some(proof.ThreadID), contracts.Some(proof.RuntimeID)
		state.ThreadConversationID = state.ConversationID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.ClaimWorkContinuation(t.Context(), record.ID, ClaimContinuationOptions{
		AttemptID: "exact-rejected-attempt", ExpectedTurnID: proof.FromTurnID, RuntimeID: proof.RuntimeID, ThreadID: proof.ThreadID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.SetWorkContinuationPhase(t.Context(), record.ID, "exact-rejected-attempt", contracts.ContinuationDispatchPhaseSubmitting); err != nil {
		t.Fatal(err)
	}
	return persistence, directory, record.ID, proof
}

func TestExactRejectedStartRetiresOnlyAnUnacknowledgedSubmittingAttemptAndSurvivesReopen(t *testing.T) {
	persistence, directory, id, proof := rejectedContinuationFixture(t)
	settled, err := persistence.SettleWorkContinuation(t.Context(), id, "exact-rejected-attempt", SettleContinuationOptions{
		Status: contracts.WorkStatusFailed, RejectedStart: &proof,
	})
	if err != nil || settled.Status != contracts.WorkStatusContinuing || settled.TurnID != proof.FromTurnID || settled.Continuation.Dispatch != nil || settled.Continuation.NextAt.Value <= persistence.Timestamp() {
		t.Fatal("explicitly rejected start retained an unknown outcome or lost its continuation", err)
	}
	persistence.Close()
	reopened, err := Open(directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state := reopened.Snapshot()
	record, err := FindWork(&state, id)
	if err != nil || record.Status != contracts.WorkStatusContinuing || record.Continuation.Dispatch != nil || record.TurnID != proof.FromTurnID || record.Continuation.Attempts != 1 {
		t.Fatal("disk reopen invented a submitted action or replaced the exact previous turn", err)
	}
	if _, err := reopened.ClaimWorkContinuation(t.Context(), id, ClaimContinuationOptions{
		AttemptID: "separate-later-attempt", ExpectedTurnID: proof.FromTurnID, RuntimeID: proof.RuntimeID, ThreadID: proof.ThreadID,
	}); err != nil {
		t.Fatal("known rejected action prevented a separately admitted later attempt", err)
	}
}

func TestRejectedStartProofCannotClearUnknownAcknowledgedOrChangedOwnership(t *testing.T) {
	for _, scenario := range []string{
		"conversation", "from-turn", "runtime", "thread", "attempt", "current-thread", "current-runtime", "current-thread-conversation",
		"submitted", "unknown-status", "acknowledged", "already-unknown", "cancelled-context",
	} {
		t.Run(scenario, func(t *testing.T) {
			persistence, _, id, proof := rejectedContinuationFixture(t)
			attempt := "exact-rejected-attempt"
			options := SettleContinuationOptions{Status: contracts.WorkStatusFailed, RejectedStart: &proof}
			ctx := t.Context()
			switch scenario {
			case "conversation":
				proof.ConversationID = "foreign-conversation"
			case "from-turn":
				proof.FromTurnID = "foreign-turn"
			case "runtime":
				proof.RuntimeID = "vm:foreign"
			case "thread":
				proof.ThreadID = "foreign-thread"
			case "attempt":
				attempt = "foreign-attempt"
			case "submitted":
				options.Submitted = true
			case "unknown-status":
				options.Status = contracts.WorkStatusUnknown
			case "acknowledged":
				if _, err := persistence.BindWorkContinuation(ctx, id, attempt, "already-accepted-turn"); err != nil {
					t.Fatal(err)
				}
			case "already-unknown":
				if _, err := persistence.SettleWorkContinuation(ctx, id, attempt, SettleContinuationOptions{Status: contracts.WorkStatusUnknown, Submitted: true}); err != nil {
					t.Fatal(err)
				}
			case "cancelled-context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			default:
				if err := persistence.Mutate(ctx, func(state *contracts.State) error {
					switch scenario {
					case "current-thread":
						state.ThreadID = contracts.Some("replacement-thread")
					case "current-runtime":
						state.ThreadRuntime = contracts.Some("vm:replacement")
					case "current-thread-conversation":
						state.ThreadConversationID = "replacement-conversation"
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			before := persistence.Snapshot()
			if _, err := persistence.SettleWorkContinuation(ctx, id, attempt, options); err == nil {
				t.Fatal("stale or uncertain proof retired an external action fence")
			}
			if !reflect.DeepEqual(persistence.Snapshot(), before) {
				t.Fatal("rejected proof partially changed durable ownership")
			}
		})
	}
}

func TestSubmittingAttemptWithoutARejectionProofRemainsUnknown(t *testing.T) {
	persistence, _, id, _ := rejectedContinuationFixture(t)
	settled, err := persistence.SettleWorkContinuation(t.Context(), id, "exact-rejected-attempt", SettleContinuationOptions{Status: contracts.WorkStatusFailed})
	if err != nil || settled.Status != contracts.WorkStatusUnknown || settled.Continuation.Dispatch == nil || settled.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown {
		t.Fatal("absence of a transport rejection proof made an uncertain start replayable", err)
	}
}
