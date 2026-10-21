package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScheduleTickRemembersExactTerminalReceiptBeforeAnotherOccurrence(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "remember-once", true: "failed-terminal-receipt"}[fail], func(t *testing.T) {
			record := job(1000)
			record.Status = contracts.ScheduleStatusDispatched
			record.Enabled = schedulePointer(false)
			record.MessageID = schedulePointer("finished-message")
			db := isolatedScheduleDatabase(t, record)
			scheduler, boundary := isolatedScheduler(t, db, func(options *Options) {
				options.Changed = func() {}
				options.Enqueue = func(context.Context, *contracts.ChatMessage) error {
					t.Fatal("terminal receipt triggered another execution")
					return nil
				}
			})
			if _, err := boundary.Add(t.Context(), &contracts.ChatMessage{
				ID: "finished-message", Role: contracts.RoleUser, Text: record.Text, ScheduleID: record.ID,
				WorkID: "completed-work", TurnID: contracts.Some("completed-turn"), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
			}); err != nil {
				t.Fatal(err)
			}
			if fail {
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'synthetic terminal receipt write failure'); END")
			}
			result, err := scheduler.Tick(t.Context())
			if (err != nil) != fail || len(result) != 0 {
				t.Fatal("terminal receipt failure was hidden or a new execution admitted", err)
			}
			if fail {
				return
			}
			snapshot, err := db.Snapshot(t.Context())
			if err != nil || len(snapshot.Items) != 1 || len(snapshot.Items[0].RunHistory) != 1 {
				t.Fatal("terminal receipt was not durably retained", err)
			}
			receipt := snapshot.Items[0].RunHistory[0]
			if receipt.MessageID != "finished-message" || receipt.WorkID == nil || *receipt.WorkID != "completed-work" || receipt.TurnID == nil || *receipt.TurnID != "completed-turn" || !terminalReceipt(receipt) {
				t.Fatal("terminal receipt lost exact execution identity")
			}
			if _, err := scheduler.Tick(t.Context()); err != nil {
				t.Fatal("remembered receipt was not idempotent", err)
			}
		})
	}
}

func TestScheduleTickFailureBoundariesNeverEnqueueAnUnconfirmedOccurrence(t *testing.T) {
	for _, mode := range []string{"connection-changed", "invalid-id", "invalid-cron", "claim-failure", "projection-failure", "materialize-failure", "already-submitted", "handoff-failure"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			if mode == "invalid-cron" {
				record.Cron = contracts.Some("invalid saved legacy expression")
			}
			db := isolatedScheduleDatabase(t, record)
			calls, availableCalls, ids := 0, 0, 0
			scheduler, boundary := isolatedScheduler(t, db, func(options *Options) {
				options.Enqueue = func(context.Context, *contracts.ChatMessage) error { calls++; return nil }
				if mode == "connection-changed" {
					options.Available = func() bool { availableCalls++; return availableCalls < 2 }
				}
				if mode == "invalid-id" {
					options.NewID = func() string {
						ids++
						if ids == 1 {
							return "scheduler-owner"
						}
						return "invalid message id"
					}
				}
			})
			switch mode {
			case "claim-failure":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedule_dispatches BEGIN SELECT RAISE(ABORT,'synthetic claim write failure'); END")
			case "projection-failure":
				boundary.mutate = func(context.Context, func(*contracts.State) error) error { return ErrUnavailable }
			case "materialize-failure":
				boundary.materialize = func(context.Context, *contracts.ChatMessage, bool) (*contracts.ChatMessage, error) {
					return nil, ErrUnavailable
				}
			case "already-submitted":
				boundary.materialize = func(ctx context.Context, message *contracts.ChatMessage, held bool) (*contracts.ChatMessage, error) {
					stored, err := boundary.Store.MaterializeScheduledMessage(ctx, message, held)
					if err != nil {
						return nil, err
					}
					// A saved observation of earlier submission is not permission
					// to repeat Engine admission, even in the same occurrence.
					stored.UnknownOutcome = true
					return stored, nil
				}
			case "handoff-failure":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_dispatches WHEN NEW.phase='handed-off' BEGIN SELECT RAISE(ABORT,'synthetic handoff fence failure'); END")
			}
			result, err := scheduler.Tick(t.Context())
			wantError := mode != "connection-changed" && mode != "invalid-cron" && mode != "already-submitted"
			if (err != nil) != wantError || len(result) != 0 || calls != 0 {
				t.Fatal("unconfirmed occurrence was enqueued or failure was hidden", mode, calls, err)
			}
		})
	}
}

func TestScheduleSortingTypedReceiptsAndGetPreserveObservedMetadata(t *testing.T) {
	low, high, normal := job(1000), job(4000), job(3000)
	low.Priority = contracts.Some(contracts.TaskPriorityLow)
	high.Priority = contracts.Some(contracts.TaskPriorityHigh)
	normal.Priority = contracts.Optional[contracts.TaskPriority]{}
	normal.TimeZone = nil
	ordered := sortedRecords([]Record{low, normal, high})
	if ordered[0].ID != high.ID || ordered[1].ID != normal.ID || ordered[2].ID != low.ID || recordZone(normal) != "UTC" {
		t.Fatal("schedule ordering ignored priority or default zone")
	}
	if same := sortedRecords([]Record{job(4000), job(3000)}); same[0].At != 3000 {
		t.Fatal("equal priority schedules were not ordered by their saved instant")
	}
	const raw = `{"id":"fixture","text":"retained text","at":1000,"status":"pending","createdAt":1000,"updatedAt":2000,"runHistory":[{"messageId":"message","at":1000,"terminalAt":2000,"terminalStatus":"completed"}]}`
	record, err := decodeRecord(json.RawMessage(raw))
	if err != nil || len(record.RunHistory) != 1 || !terminalReceipt(record.RunHistory[0]) {
		t.Fatal("typed terminal receipt was not preserved", err)
	}
	if _, err := decodeRecord(json.RawMessage(strings.Replace(raw, `"id":"fixture"`, `"id":"\ud800"`, 1))); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid Unicode identity accepted", err)
	}
	db := isolatedScheduleDatabase(t, record)
	scheduler, _ := isolatedScheduler(t, db, nil)
	view, err := scheduler.Get(t.Context(), record.ID)
	if err != nil || !strings.Contains(string(view), "retained text") || !strings.Contains(string(view), `"terminalStatus":"completed"`) {
		t.Fatal("read-only schedule projection lost observed receipt", err)
	}
}
