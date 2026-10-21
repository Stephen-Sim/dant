package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAcceptingReviewRequiresConfirmedRelatedWorkEvenWithoutAContinuation(t *testing.T) {
	for _, kind := range []string{"unknown outcome", "submitting", "unknown submission"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _, _ := progressFixture(t)
			if err := s.Mutate(t.Context(), func(state *contracts.State) error {
				state.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusReview))
				state.WorkTasks[0].Status = contracts.WorkStatusReview
				switch kind {
				case "unknown outcome":
					state.WorkTasks[0].UnknownOutcome = true
				case "submitting":
					state.WorkTasks[0].Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
				case "unknown submission":
					state.WorkTasks[0].Submission = contracts.Some(contracts.SubmissionStatusUnknown)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Confirm(t.Context(), "task"); err == nil {
				t.Fatal("accepting a visible result confirmed an unknown related execution")
			}
			after := s.Snapshot()
			if after.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusReview) || after.Messages[0].AcceptedAt.Present || after.WorkTasks[0].Status != contracts.WorkStatusReview {
				t.Fatal("failed acceptance changed durable execution state")
			}
		})
	}
}

func TestRegisterWorkRejectsUnownedTurnsInvalidPlansAndCancelledRecords(t *testing.T) {
	for _, kind := range []string{"missing turn", "unknown source", "missing plan", "empty observed title", "long observed title", "invalid plan", "missing previous", "cancelled", "running previous", "reused turn"} {
		t.Run(kind, func(t *testing.T) {
			s, _, previous, _ := progressFixture(t)
			input := RegisterWorkOptions{TurnID: "new-turn", Source: "chat", Title: "A new plan", Plan: previous.Plan}
			switch kind {
			case "missing turn":
				input.TurnID = ""
			case "unknown source":
				input.Source = "foreign"
			case "missing plan":
				input.Plan = nil
			case "empty observed title":
				input.Plan, input.Observed, input.Title = nil, true, " "
			case "long observed title":
				input.Plan, input.Observed, input.Title = nil, true, strings.Repeat("x", 1000)
			case "invalid plan":
				input.Plan = &contracts.TaskPlan{}
			case "missing previous":
				input.WorkID = "missing"
			default:
				input.WorkID = previous.ID
				if err := s.Mutate(t.Context(), func(state *contracts.State) error {
					w := &state.WorkTasks[0]
					switch kind {
					case "cancelled":
						w.Status = contracts.WorkStatusCancelled
					case "running previous":
						w.Status = contracts.WorkStatusRunning
					case "reused turn":
						w.Status = contracts.WorkStatusPaused
						w.TurnIDs = append(w.TurnIDs, input.TurnID)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			before := s.Revision()
			if _, err := s.RegisterWork(t.Context(), input); err == nil || s.Revision() != before {
				t.Fatal("invalid work admission committed a task", kind, err)
			}
		})
	}
}

func TestRegisteredWorkUpdateKeepsCancelledAndInvalidExecutionsUnchanged(t *testing.T) {
	for _, kind := range []string{"cancelled status", "cancelled plan", "null status", "invalid status", "invalid plan", "invalid end timestamp", "missing work"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _, _ := progressFixture(t)
			input, turn := UpdateRegisteredWorkOptions{}, "turn"
			switch kind {
			case "cancelled status", "cancelled plan":
				if err := s.Mutate(t.Context(), func(state *contracts.State) error {
					state.WorkTasks[0].Status = contracts.WorkStatusCancelled
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if kind == "cancelled status" {
					input.Status = contracts.Some(contracts.WorkStatusRunning)
				} else {
					input.Plan = &contracts.TaskPlan{}
				}
			case "null status":
				input.Status = contracts.Null[contracts.WorkStatus]()
			case "invalid status":
				input.Status = contracts.Some(contracts.WorkStatus("foreign"))
			case "invalid plan":
				input.Plan = &contracts.TaskPlan{}
			case "invalid end timestamp":
				input.ExecutionEnded, input.At = true, -1
			case "missing work":
				turn = "missing"
			}
			before := s.Revision()
			result, err := s.UpdateRegisteredWork(t.Context(), turn, input)
			if kind == "missing work" {
				if err != nil || result != nil || s.Revision() != before {
					t.Fatal("missing work produced a new execution", err)
				}
			} else if err == nil || s.Revision() != before {
				t.Fatal("rejected execution update changed work", kind, err)
			}
		})
	}
}

func TestConfirmedReviewCommitsAcceptedAtAndRelatedWorkExactlyOnce(t *testing.T) {
	s, _, _, _ := progressFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Messages[0].Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusReview))
		state.WorkTasks[0].Status = contracts.WorkStatusReview
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	accepted, err := s.Confirm(t.Context(), "task")
	if err != nil || accepted.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || accepted.AcceptedAt.Value != s.Timestamp() || s.Snapshot().WorkTasks[0].Status != contracts.WorkStatusCompleted {
		t.Fatal("confirmed result was not accepted durably", err)
	}
	if _, err := s.Confirm(t.Context(), "task"); err == nil {
		t.Fatal("already accepted task was accepted again")
	}
	if _, err := s.Confirm(t.Context(), "missing"); !errors.Is(err, ErrMessageNotFound) {
		t.Fatal("missing message was accepted", err)
	}
}
