package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScheduleSaveRejectsInvalidClockOrGeneratedIdentityWithoutCommitting(t *testing.T) {
	for _, mode := range []string{"invalid-clock", "calendar-exhausted", "invalid-new-id"} {
		t.Run(mode, func(t *testing.T) {
			database := isolatedScheduleDatabase(t)
			ids := 0
			scheduler, boundary := isolatedScheduler(t, database, func(options *Options) {
				switch mode {
				case "invalid-clock":
					options.Now = func() time.Time { return time.UnixMilli(0) }
				case "calendar-exhausted":
					options.Now = func() time.Time { return time.UnixMilli(MaxTime) }
				case "invalid-new-id":
					options.NewID = func() string {
						ids++
						if ids == 1 {
							return "fixture-owner"
						}
						return "invalid generated identity"
					}
				}
			})
			before, err := database.Snapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			input := json.RawMessage(`{"text":"Requested occurrence","at":3000}`)
			if mode == "calendar-exhausted" {
				input = json.RawMessage(`{"text":"Requested occurrence","cron":"* * * * *","timeZone":"UTC"}`)
			}

			if _, err := scheduler.Save(t.Context(), input, true); !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid admission metadata was accepted", err)
			}
			after, err := database.Snapshot(t.Context())
			if err != nil || after.Revision != before.Revision || len(after.Items) != 0 || len(boundary.Snapshot().Schedules) != 0 {
				t.Fatal("rejected admission left a durable occurrence or changed the projection", err)
			}
		})
	}
}

func TestScheduleRefreshRepairsStaleTombstoneProjectionFromSQLite(t *testing.T) {
	database := isolatedScheduleDatabase(t)
	scheduleSQL(t, database, "INSERT INTO schedule_tombstones VALUES(?)", "authoritative-request")
	scheduler, boundary := isolatedScheduler(t, database, nil)
	if err := boundary.Store.Mutate(t.Context(), func(state *contracts.State) error {
		state.DeletedScheduleRequestIDs = []string{"stale-projection"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if result, err := scheduler.List(t.Context()); err != nil || len(result.Items) != 0 {
		t.Fatal("authoritative empty schedule listing failed", err)
	}
	projection := boundary.Snapshot().DeletedScheduleRequestIDs
	if len(projection) != 1 || projection[0] != "authoritative-request" {
		t.Fatal("same-size stale tombstones overrode SQLite authority", projection)
	}
}

func TestScheduleRemovalRetainsOtherRecordsAndDeduplicatesExistingTombstone(t *testing.T) {
	removed, retained := job(3000), job(4000)
	removed.ClientRequestID = schedulePointer("already-deleted-request")
	database := isolatedScheduleDatabase(t, removed, retained)
	scheduleSQL(t, database, "INSERT INTO schedule_tombstones VALUES(?)", *removed.ClientRequestID)
	scheduler, boundary := isolatedScheduler(t, database, nil)

	if _, err := scheduler.Remove(t.Context(), removed.ID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := database.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 1 || snapshot.Items[0].ID != retained.ID || len(snapshot.DeletedRequestIDs) != 1 || snapshot.DeletedRequestIDs[0] != *removed.ClientRequestID {
		t.Fatal("removal lost an unrelated record or duplicated the request fence", err)
	}
	if len(boundary.Snapshot().Schedules) != 1 {
		t.Fatal("removal did not publish the retained record")
	}
}

func TestScheduleRemovalProjectionFailureRetainsCommittedDeletionWithoutReplay(t *testing.T) {
	record := job(3000)
	database := isolatedScheduleDatabase(t, record)
	scheduler, boundary := isolatedScheduler(t, database, nil)
	denied := errors.New("synthetic removal projection failure")
	commits := 0
	authorize := func(ctx context.Context, commit func(context.Context) error) error {
		commits++
		if err := commit(ctx); err != nil {
			return err
		}
		boundary.mutate = func(context.Context, func(*contracts.State) error) error {
			return denied
		}
		return nil
	}

	if _, err := scheduler.RemoveAuthorized(t.Context(), record.ID, authorize); !errors.Is(err, denied) {
		t.Fatal("post-commit projection failure was hidden", err)
	}
	snapshot, err := database.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 0 || commits != 1 {
		t.Fatal("projection failure replayed or reverted the committed deletion", commits, err)
	}
	boundary.mutate = nil
	if _, err := scheduler.RemoveAuthorized(t.Context(), record.ID, authorize); !errors.Is(err, ErrNotFound) || commits != 1 {
		t.Fatal("absent occurrence was deleted a second time", commits, err)
	}
	if len(boundary.Snapshot().Schedules) != 0 {
		t.Fatal("subsequent reconciliation restored a deleted occurrence")
	}
}

func TestScheduleCancelledCommitRollsBackAllRecords(t *testing.T) {
	record := job(3000)
	database := isolatedScheduleDatabase(t, record)
	before, err := database.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	record.Text = "Changed request before cancelled commit"
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	if err := database.Replace(ctx, before.Revision, []Record{record}, []string{"pending-deletion"}, func() error {
		cancel()
		return nil
	}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled commit lost its classification", err)
	}
	after, err := database.Snapshot(t.Context())
	if err != nil || after.Revision != before.Revision || len(after.Items) != 1 || after.Items[0].Text != before.Items[0].Text || len(after.DeletedRequestIDs) != 0 {
		t.Fatal("cancelled final commit retained partial records or tombstones", err)
	}
}
