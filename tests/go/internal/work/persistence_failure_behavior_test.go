package work

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type workPersistenceFault struct {
	armed    atomic.Bool
	failures atomic.Int32
	match    func(contracts.State) bool
}

func (fault *workPersistenceFault) write(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
	if fault.armed.Load() {
		var state contracts.State
		if json.Unmarshal(data, &state) == nil && fault.match(state) && fault.armed.CompareAndSwap(true, false) {
			fault.failures.Add(1)
			return errors.New("isolated_conversation_write_failure")
		}
	}
	return files.WriteAtomic(ctx, path, data, mode)
}

func TestAdmissionAndQueuePersistenceFailuresHaveNoPartialMessageOrExternalDispatch(t *testing.T) {
	for _, publicAdmission := range []bool{false, true} {
		t.Run(map[bool]string{false: "enqueue", true: "public-admission"}[publicAdmission], func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				return len(state.Messages) > 0 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusQueued)
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			input := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "preserve this exact input", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft))}
			if !publicAdmission {
				var err error
				input, err = persistence.Add(context.Background(), input)
				if err != nil {
					t.Fatal(err)
				}
			}
			fault.armed.Store(true)
			var err error
			if publicAdmission {
				_, err = engine.AdmitMessage(context.Background(), persistence.ConversationID(), input)
			} else {
				err = engine.Enqueue(context.Background(), input)
			}
			if !errors.Is(err, store.ErrPersistence) || fault.failures.Load() != 1 || len(engine.Snapshot().Queue) != 0 || engine.Snapshot().Active != nil {
				t.Fatal("failed atomic admission partially entered execution", err)
			}
			state := persistence.Snapshot()
			if publicAdmission && len(state.Messages) != 0 || !publicAdmission && (len(state.Messages) != 1 || state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusDraft) || state.Messages[0].Text != input.Text) {
				t.Fatal("failed state write changed the authoritative message")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestPreparationPersistenceFailuresCannotFallThroughToAModelTurn(t *testing.T) {
	for _, phase := range []string{"preparing", "thread-binding", "submitting"} {
		t.Run(phase, func(t *testing.T) {
			fault := &workPersistenceFault{match: func(state contracts.State) bool {
				if len(state.Messages) != 1 {
					return false
				}
				switch phase {
				case "preparing":
					return state.Messages[0].Submission.Value == contracts.SubmissionStatusPreparing
				case "thread-binding":
					return state.ThreadID.Value != ""
				default:
					return state.Messages[0].Submission.Value == contracts.SubmissionStatusSubmitting
				}
			}}
			engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "authorized input"})
			if err != nil {
				t.Fatal(err)
			}
			fault.armed.Store(true)
			if err := engine.Enqueue(context.Background(), message); err != nil {
				t.Fatal(err)
			}
			if phase != "preparing" {
				thread := nextRequest(t, worker, "thread/start")
				thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
			}
			waitSnapshot(t, engine, func(state Snapshot) bool { return state.Active == nil && len(state.Queue) == 0 })
			stored, err := persistence.Message(message.ID)
			if err != nil || fault.failures.Load() != 1 || stored.Text != message.Text {
				t.Fatal("fault injection missed the public persistence boundary or changed user content", err)
			}
			if phase == "submitting" {
				if !stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusUnknown || !engine.Snapshot().Executor.Paused {
					t.Fatal("uncertain dispatch preparation was treated as replayable")
				}
			} else if stored.UnknownOutcome || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) {
				t.Fatal("pre-submit failure invented a confirmed external action")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestFailedTerminalPersistenceRetainsItsOwnerAndRevokesFurtherToolAuthority(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool {
		return len(state.Messages) > 0 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusReview)
	}}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "terminal-save-failure-turn")
	fault.armed.Store(true)
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); !errors.Is(err, store.ErrPersistence) {
		t.Fatal("terminal persistence failure claimed a settled outcome", err)
	}
	snapshot := engine.Snapshot()
	if fault.failures.Load() != 1 || snapshot.Active == nil || snapshot.Active.TurnID.Value != owner.TurnID || !snapshot.Executor.Paused || owner.IsCurrent() {
		t.Fatal("failed terminal save retired ownership or left external tool authority active")
	}
	if _, err := engine.DeliverText(context.Background(), "late unconfirmed output", owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("unconfirmed terminal owner continued producing side effects", err)
	}
	engine.Wake()
	assertWorkerQuiet(t, worker)
}

func TestLocalDeliveryFailureDoesNotClaimSentAndAnExplicitLaterSaveCreatesOnlyOneMessage(t *testing.T) {
	fault := &workPersistenceFault{match: func(state contracts.State) bool { return len(state.Messages) == 2 }}
	engine, persistence, worker := engineFixtureWithStoreOptions(t, store.Options{Write: fault.write})
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "delivery-save-failure-turn")
	fault.armed.Store(true)
	if _, err := engine.DeliverText(context.Background(), "verified local output", owner); !errors.Is(err, store.ErrPersistence) || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("failed delivery claimed publication or partially persisted chat", err)
	}
	if _, err := engine.DeliverText(context.Background(), "verified local output", owner); err != nil {
		t.Fatal("explicit later local save could not publish after a known write rejection", err)
	}
	if state := persistence.Snapshot(); len(state.Messages) != 2 || state.Messages[1].Text != "verified local output" || fault.failures.Load() != 1 {
		t.Fatal("local save duplicated content or lost its public result")
	}
	assertWorkerQuiet(t, worker)
}
