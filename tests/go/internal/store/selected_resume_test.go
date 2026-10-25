package store

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func selectedPausedStoreFixture(t *testing.T) (*Store, string, string, ClaimContinuationOptions) {
	t.Helper()
	directory := t.TempDir()
	persistence, err := Open(directory, Options{Now: func() time.Time { return time.UnixMilli(4000) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(persistence.Close)
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "Synthetic remaining work", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := persistence.RegisterWork(t.Context(), RegisterWorkOptions{
		TurnID: "selected-original-turn", MessageID: "selected-original-input", Source: "chat",
		Title: "Synthetic explicit selection", StartedAt: 2000, Plan: &plan,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.UpdateRegisteredWork(t.Context(), record.TurnID, UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true, At: 3000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
		state.ThreadID, state.ThreadRuntime = contracts.Some("selected-thread"), contracts.Some("vm:selected-runtime")
		state.ThreadConversationID = state.ConversationID
		state.Messages = append(state.Messages,
			&contracts.ChatMessage{
				ID: "historical-unknown", Role: contracts.RoleUser, Text: "Synthetic historical uncertainty",
				Time: contracts.Some(float64(1000)), ReceivedAt: contracts.Some(float64(1100)),
				TaskID: contracts.Some("historical-unknown"), ExecutionEndedAt: contracts.Null[float64](),
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusUnknown)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
				Reactions: []string{}, Extra: contracts.RawObject{"syntheticFuture": json.RawMessage(`{"keep":true}`)},
			},
			&contracts.ChatMessage{
				ID: "selected-original-input", Role: contracts.RoleUser, Text: "Synthetic selected input",
				Time: contracts.Some(float64(2000)), WorkID: record.ID, TurnID: contracts.Some(record.TurnID),
				Submission: contracts.Some(contracts.SubmissionStatusConfirmed), Reactions: []string{},
			},
		)
		selected, err := FindWork(state, record.ID)
		if err != nil {
			return err
		}
		selected.PauseReason = contracts.Some("user")
		selected.Continuation = &contracts.WorkContinuation{
			NextAt: contracts.Null[float64](), Attempts: 3, NoProgressCount: 1, LastCheckpoint: workstate.Checkpoint(selected.Plan),
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	options := ClaimContinuationOptions{
		ExpectedTurnID: record.TurnID, AttemptID: "selected-attempt", RuntimeID: "vm:selected-runtime", ThreadID: "selected-thread", At: 4000,
	}
	return persistence, directory, record.ID, options
}

func selectedStateBytes(t *testing.T, persistence *Store) []byte {
	t.Helper()
	raw, err := json.Marshal(persistence.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func assertSelectedRejectionUnchanged(t *testing.T, persistence *Store, change func() error) {
	t.Helper()
	before, revision := selectedStateBytes(t, persistence), persistence.Revision()
	disk, err := os.ReadFile(persistence.file)
	if err != nil {
		t.Fatal(err)
	}
	if err := change(); err == nil {
		t.Fatal("unconfirmed selection unexpectedly claimed an execution")
	}
	afterDisk, err := os.ReadFile(persistence.file)
	if err != nil || string(before) != string(selectedStateBytes(t, persistence)) || string(disk) != string(afterDisk) || persistence.Revision() != revision {
		t.Fatal("rejected claim leaked a continuing transition or changed disk state", err)
	}
}

func TestSelectedPausedClaimPersistsOneOwnedTransitionAndRetainsHistoricalUnknown(t *testing.T) {
	persistence, _, id, options := selectedPausedStoreFixture(t)
	before := persistence.Snapshot()
	unknownBefore, err := json.Marshal(before.Messages[0])
	if err != nil {
		t.Fatal(err)
	}
	revision := persistence.Revision()
	claimed, err := persistence.ClaimPausedWorkContinuation(t.Context(), persistence.ConversationID(), id, options)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != contracts.WorkStatusContinuing || claimed.Continuation == nil || claimed.Continuation.Dispatch == nil || persistence.Revision() != revision+1 {
		t.Fatal("selected work was exposed without a matching atomic dispatch")
	}
	dispatch := claimed.Continuation.Dispatch
	if dispatch.ID != options.AttemptID || dispatch.FromTurnID != options.ExpectedTurnID || dispatch.RuntimeID != options.RuntimeID || dispatch.ThreadID != options.ThreadID || dispatch.Phase != contracts.ContinuationDispatchPhaseClaimed || claimed.TurnID != options.ExpectedTurnID || claimed.Continuation.Attempts != 4 {
		t.Fatal("selected claim lost its exact owner or attempt history")
	}
	raw, err := os.ReadFile(persistence.file)
	if err != nil {
		t.Fatal(err)
	}
	var persisted contracts.State
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatal(err)
	}
	saved, err := FindWork(&persisted, id)
	if err != nil || saved == nil || saved.Status != contracts.WorkStatusContinuing {
		t.Fatal("claim acknowledgement preceded its complete disk commit", err)
	}
	savedContinuation, err := json.Marshal(saved.Continuation)
	if err != nil {
		t.Fatal(err)
	}
	claimedContinuation, err := json.Marshal(claimed.Continuation)
	if err != nil || string(savedContinuation) != string(claimedContinuation) {
		t.Fatal("saved claim lost public continuation data or its exact dispatch owner", err)
	}
	unknownAfter, err := json.Marshal(persisted.Messages[0])
	if err != nil || string(unknownAfter) != string(unknownBefore) || !persisted.Messages[0].UnknownOutcome {
		t.Fatal("resuming an unrelated task reconciled or replayed an old unknown", err)
	}
	assertSelectedRejectionUnchanged(t, persistence, func() error {
		_, err := persistence.ClaimPausedWorkContinuation(t.Context(), persistence.ConversationID(), id, options)
		return err
	})
}

func TestSelectedPausedClaimRejectsStaleScopeTimeDuplicateAndUncertainOwnerAtomically(t *testing.T) {
	for _, scenario := range []string{
		"conversation", "empty-conversation", "thread-conversation", "thread", "runtime", "from-turn", "human-reply",
		"duplicate-work-id", "duplicate-attempt", "related-unknown", "newer-orphan", "equal-orphan", "missing-orphan-time",
		"null-orphan-time", "unknown-work", "already-dispatched", "cancelled-context", "persistence-failure",
	} {
		t.Run(scenario, func(t *testing.T) {
			persistence, _, id, options := selectedPausedStoreFixture(t)
			conversation, ctx := persistence.ConversationID(), t.Context()
			switch scenario {
			case "conversation":
				conversation = "foreign-conversation"
			case "empty-conversation":
				conversation = ""
			case "thread":
				options.ThreadID = "foreign-thread"
			case "runtime":
				options.RuntimeID = "vm:foreign"
			case "from-turn":
				options.ExpectedTurnID = "foreign-turn"
			case "human-reply":
				options.HumanReply = true
			case "cancelled-context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "persistence-failure":
				persistence.write = func(context.Context, string, []byte, fs.FileMode) error { return errors.New("synthetic write failure") }
			default:
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					selected, err := FindWork(state, id)
					if err != nil {
						return err
					}
					switch scenario {
					case "thread-conversation":
						state.ThreadConversationID = "foreign-conversation"
					case "duplicate-work-id":
						state.WorkTasks = append(state.WorkTasks, *selected)
					case "duplicate-attempt":
						other := *selected
						other.ID, other.TurnID, other.TurnIDs = "00000000-0000-4000-8000-000000000099", "other-turn", []string{"other-turn"}
						other.MessageID, other.MessageIDs = contracts.Null[string](), nil
						other.Status = contracts.WorkStatusContinuing
						other.Continuation = &contracts.WorkContinuation{NextAt: contracts.Some(float64(4000)), Attempts: 1, LastCheckpoint: workstate.Checkpoint(other.Plan), Dispatch: &contracts.ContinuationDispatch{ID: options.AttemptID, FromTurnID: other.TurnID, RuntimeID: options.RuntimeID, ThreadID: options.ThreadID, CreatedAt: 4000, Phase: contracts.ContinuationDispatchPhaseClaimed}}
						state.WorkTasks = append(state.WorkTasks, other)
					case "related-unknown":
						state.Messages[0].WorkID = id
					case "newer-orphan":
						state.Messages[0].Time = contracts.Some(float64(2001))
					case "equal-orphan":
						state.Messages[0].ReceivedAt = contracts.Some(float64(2000))
					case "missing-orphan-time":
						state.Messages[0].Time = contracts.Optional[float64]{}
					case "null-orphan-time":
						state.Messages[0].Time = contracts.Null[float64]()
					case "unknown-work":
						selected.UnknownOutcome = true
					case "already-dispatched":
						selected.Continuation.Dispatch = &contracts.ContinuationDispatch{ID: "existing-attempt", FromTurnID: selected.TurnID, RuntimeID: options.RuntimeID, ThreadID: options.ThreadID, CreatedAt: 3000, Phase: contracts.ContinuationDispatchPhaseSubmitting}
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "duplicate-attempt" {
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					other, err := FindWork(state, "00000000-0000-4000-8000-000000000099")
					if err != nil || other.Continuation == nil || other.Continuation.Dispatch == nil || other.Continuation.Dispatch.ID != options.AttemptID {
						return errors.New("synthetic duplicate attempt did not survive normal loading")
					}
					return ErrNoChange
				}); err != nil {
					t.Fatal(err)
				}
			}
			assertSelectedRejectionUnchanged(t, persistence, func() error {
				_, err := persistence.ClaimPausedWorkContinuation(ctx, conversation, id, options)
				return err
			})
		})
	}
}

func TestSelectedPausedRejectedStartRequiresExactProofAndNeverClearsHistoricalUnknown(t *testing.T) {
	for _, scenario := range []string{"known-rejected", "wrong-conversation", "wrong-thread", "wrong-runtime", "wrong-from-turn", "unknown-transport"} {
		t.Run(scenario, func(t *testing.T) {
			persistence, directory, id, options := selectedPausedStoreFixture(t)
			if _, err := persistence.ClaimPausedWorkContinuation(t.Context(), persistence.ConversationID(), id, options); err != nil {
				t.Fatal(err)
			}
			if _, err := persistence.SetWorkContinuationPhase(t.Context(), id, options.AttemptID, contracts.ContinuationDispatchPhaseSubmitting); err != nil {
				t.Fatal(err)
			}
			before := persistence.Snapshot()
			proof := &RejectedContinuationStart{ConversationID: persistence.ConversationID(), FromTurnID: options.ExpectedTurnID, RuntimeID: options.RuntimeID, ThreadID: options.ThreadID}
			switch scenario {
			case "wrong-conversation":
				proof.ConversationID = "foreign-conversation"
			case "wrong-thread":
				proof.ThreadID = "foreign-thread"
			case "wrong-runtime":
				proof.RuntimeID = "vm:foreign"
			case "wrong-from-turn":
				proof.FromTurnID = "foreign-turn"
			case "unknown-transport":
				proof = nil
			}
			settle := func() (*contracts.WorkRecord, error) {
				return persistence.SettleWorkContinuation(t.Context(), id, options.AttemptID, SettleContinuationOptions{Status: contracts.WorkStatusPaused, At: 4500, RejectedStart: proof})
			}
			if scenario != "known-rejected" && scenario != "unknown-transport" {
				assertSelectedRejectionUnchanged(t, persistence, func() error { _, err := settle(); return err })
				return
			}
			settled, err := settle()
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "known-rejected" {
				if settled.Status != contracts.WorkStatusPaused || settled.Continuation.Dispatch != nil || settled.TurnID != options.ExpectedTurnID {
					t.Fatal("known rejection did not retain a resumable, unchanged previous owner")
				}
			} else if settled.Status != contracts.WorkStatusUnknown || settled.Continuation.Dispatch == nil || settled.Continuation.Dispatch.Phase != contracts.ContinuationDispatchPhaseUnknown {
				t.Fatal("unconfirmed transport was converted into a known rejected start")
			}
			after := persistence.Snapshot()
			if !reflect.DeepEqual(before.Messages, after.Messages) {
				t.Fatal("settling one exact attempt changed another input's unknown outcome")
			}
			if scenario == "known-rejected" {
				persistence.Close()
				reopened, err := Open(directory, Options{Now: func() time.Time { return time.UnixMilli(5000) }})
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				persisted := reopened.Snapshot()
				if !persisted.Messages[0].UnknownOutcome || persisted.Messages[0].Submission.Value != contracts.SubmissionStatusUnknown {
					t.Fatal("reopen cleared historical uncertainty after a selected known rejection")
				}
			}
		})
	}
}
