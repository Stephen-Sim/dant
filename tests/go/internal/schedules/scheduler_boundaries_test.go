package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type schedulePersistenceBoundary struct {
	*store.Store
	mutate      func(context.Context, func(*contracts.State) error) error
	materialize func(context.Context, *contracts.ChatMessage, bool) (*contracts.ChatMessage, error)
}

func (boundary *schedulePersistenceBoundary) Mutate(ctx context.Context, change func(*contracts.State) error) error {
	if boundary.mutate != nil {
		return boundary.mutate(ctx, change)
	}
	return boundary.Store.Mutate(ctx, change)
}

func (boundary *schedulePersistenceBoundary) MaterializeScheduledMessage(ctx context.Context, message *contracts.ChatMessage, held bool) (*contracts.ChatMessage, error) {
	if boundary.materialize != nil {
		return boundary.materialize(ctx, message, held)
	}
	return boundary.Store.MaterializeScheduledMessage(ctx, message, held)
}

func isolatedScheduler(t *testing.T, db *Database, customize func(*Options)) (*Scheduler, *schedulePersistenceBoundary) {
	t.Helper()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(persistence.Close)
	boundary := &schedulePersistenceBoundary{Store: persistence}
	options := Options{Now: func() time.Time { return time.UnixMilli(2000) }, Available: func() bool { return true }, Enqueue: func(context.Context, *contracts.ChatMessage) error { return nil }}
	if customize != nil {
		customize(&options)
	}
	scheduler, err := New(t.Context(), db, boundary, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = scheduler.Close() })
	return scheduler, boundary
}

func TestScheduleReadAndMutationBoundariesPropagateUnavailableAuthority(t *testing.T) {
	db := isolatedScheduleDatabase(t)
	scheduler, _ := isolatedScheduler(t, db, nil)
	_ = db.Close()
	for _, read := range []func() error{
		func() error { _, err := scheduler.List(t.Context()); return err },
		func() error { _, err := scheduler.Get(t.Context(), "valid-id"); return err },
		func() error {
			_, err := scheduler.Save(t.Context(), json.RawMessage(`{"text":"request","at":3000}`), true)
			return err
		},
		func() error { _, err := scheduler.Remove(t.Context(), "valid-id"); return err },
		func() error { _, err := scheduler.Reconcile(t.Context()); return err },
		func() error { _, err := scheduler.Tick(t.Context()); return err },
	} {
		if !errors.Is(read(), ErrUnavailable) {
			t.Fatal("unavailable schedule authority was coerced into a successful operation")
		}
	}
	if _, err := New(t.Context(), db, scheduler.store, scheduler.options); !errors.Is(err, ErrUnavailable) {
		t.Fatal("constructor hid reconciliation failure", err)
	}
}

func TestScheduleReconciliationPreservesHeldDispatchAndNeverEnqueuesAfterProjectionFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "materialize-held", true: "failed-materialize-held"}[fail], func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			scheduler, boundary := isolatedScheduler(t, db, func(options *Options) {
				options.Enqueue = func(context.Context, *contracts.ChatMessage) error {
					t.Fatal("reconciliation replayed a held occurrence")
					return nil
				}
			})
			claim := makeClaim(t, db, record, "previous-owner")
			if claimed, err := db.Claim(t.Context(), claim); err != nil || !claimed {
				t.Fatal(err)
			}
			denied := errors.New("synthetic held materialization failure")
			if fail {
				boundary.materialize = func(context.Context, *contracts.ChatMessage, bool) (*contracts.ChatMessage, error) {
					return nil, denied
				}
			}
			count, err := scheduler.Reconcile(t.Context())
			if fail {
				if !errors.Is(err, ErrUnavailable) || count != 0 || len(boundary.Snapshot().Messages) != 0 {
					t.Fatal("failed held occurrence was invented or classified as committed", count, err)
				}
				return
			}
			if err != nil || count != 1 {
				t.Fatal("held occurrence was lost", count, err)
			}
			message, err := boundary.Message(claim.Message.ID)
			if err != nil || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || message.ScheduleID != record.ID {
				t.Fatal("reconciliation changed occurrence identity or made it executable", err)
			}
		})
	}
}

func TestSchedulePriorityProjectionFailureRollsBackSQLiteAndCommittedProjectionFailureDoesNotReplay(t *testing.T) {
	record := job(3000)
	db := isolatedScheduleDatabase(t, record)
	scheduler, boundary := isolatedScheduler(t, db, nil)
	denied := errors.New("synthetic history projection failure")
	boundary.mutate = func(context.Context, func(*contracts.State) error) error { return denied }
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","priority":"high"}`), true); !errors.Is(err, ErrUnavailable) {
		t.Fatal("failed priority projection was reported as committed", err)
	}
	snapshot, err := db.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 1 || priority(snapshot.Items[0]) != contracts.TaskPriorityNormal {
		t.Fatal("priority failure left a partial SQLite mutation", err)
	}
	boundary.mutate = nil
	commits := 0
	authorize := func(ctx context.Context, commit func(context.Context) error) error {
		commits++
		if err := commit(ctx); err != nil {
			return err
		}
		boundary.mutate = func(context.Context, func(*contracts.State) error) error { return denied }
		return nil
	}
	if _, err := scheduler.SaveAuthorized(t.Context(), json.RawMessage(`{"text":"second requested occurrence","at":4000}`), true, authorize); !errors.Is(err, denied) {
		t.Fatal("failed projection lost its committed-authority distinction", err)
	}
	if snapshot, err := db.Snapshot(t.Context()); err != nil || len(snapshot.Items) != 2 || commits != 1 {
		t.Fatal("projection failure lost the committed schedule or replayed commit", commits, err)
	}
}

func TestScheduleEditPreservesLegacyIdempotencyAndOnlyChangesQueuedInactivePriority(t *testing.T) {
	request := freshID()
	record := job(3000)
	record.ClientRequestID = &request
	record.CreationFingerprint = contracts.Some(hashJSON(struct {
		Text     string  `json:"text"`
		At       float64 `json:"at"`
		TimeZone string  `json:"timeZone"`
		Enabled  bool    `json:"enabled"`
	}{record.Text, record.At, "UTC", true}))
	db := isolatedScheduleDatabase(t, record)
	scheduler, boundary := isolatedScheduler(t, db, func(options *Options) { options.ActiveIDs = func() []string { return []string{"active-message"} } })
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"text":"`+record.Text+`","at":3000,"timeZone":"UTC","clientRequestId":"`+request+`"}`), true); err != nil {
		t.Fatal("compatible saved creation fingerprint was not recognized", err)
	}
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"text":"different request","at":3000,"clientRequestId":"`+request+`"}`), true); !errors.Is(err, ErrConflict) {
		t.Fatal("changed idempotency input was accepted", err)
	}
	for _, id := range []string{"active-message", "inactive-message"} {
		if _, err := boundary.Add(t.Context(), &contracts.ChatMessage{ID: id, Role: contracts.RoleUser, Text: "queued occurrence", Scheduled: true, ScheduleID: record.ID, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","priority":"high"}`), true); err != nil {
		t.Fatal(err)
	}
	active, _ := boundary.Message("active-message")
	inactive, _ := boundary.Message("inactive-message")
	if active.ProgressPriority.Present || inactive.ProgressPriority.Value != contracts.TaskPriorityHigh {
		t.Fatal("priority edit rewrote active work or omitted its queued inactive occurrence")
	}
	if snapshot, err := db.Snapshot(t.Context()); err != nil || len(snapshot.Items) != 1 {
		t.Fatal("idempotent edit duplicated its durable record", err)
	}
}

func TestSchedulePresentationCronAndClockBoundariesRemainExplicit(t *testing.T) {
	record := job(1000)
	record.TimeZone = schedulePointer("invalid/saved-zone")
	record.At = 0
	result, err := present(record, contracts.State{})
	if err != nil || !strings.Contains(string(result), `"timeZone":"UTC"`) || !strings.Contains(string(result), `"atISO":null`) {
		t.Fatal("invalid legacy calendar metadata was guessed", err)
	}
	record.At = math.NaN()
	if _, err := present(record, contracts.State{}); err == nil {
		t.Fatal("non-finite stored timestamp was presented")
	}
	for _, cron := range []string{"*/ * * * *", "*/123 * * * *", "*/a * * * *", "1-2-3 * * * *", strings.Repeat("*", 257), "* * * * *\n"} {
		if _, err := ParseCron(cron); !errors.Is(err, ErrInvalid) {
			t.Fatal("malformed cron was accepted", err)
		}
	}
	if _, err := NextAt("* * * * *", 1000, "invalid/zone"); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid authored time zone was guessed", err)
	}
	if next, err := NextAt("* * * * *", 1, "UTC"); err != nil || next != 60000 {
		t.Fatal("epoch boundary skipped its first real minute", next, err)
	}
	synctest.Test(t, func(t *testing.T) {
		db := isolatedScheduleDatabase(t)
		scheduler, _ := isolatedScheduler(t, db, nil)
		scheduler.Start(t.Context())
		synctest.Wait()
		time.Sleep(schedulerPollInterval + time.Millisecond)
		synctest.Wait()
		if err := scheduler.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-scheduler.done:
		default:
			t.Fatal("polling owner did not join its ticker on shutdown")
		}
	})
}
