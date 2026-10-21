package schedules

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScheduleCompletedOccurrenceNeedsAnExplicitNewTimeBeforeRearming(t *testing.T) {
	record := job(1000)
	database := isolatedScheduleDatabase(t, record)
	claim := makeClaim(t, database, record, "previous-owner")
	if claimed, err := database.Claim(t.Context(), claim); err != nil || !claimed {
		t.Fatal("fixture occurrence was not durably claimed", err)
	}
	scheduler, boundary := isolatedScheduler(t, database, nil)
	before, err := database.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","text":"edited request"}`), true); !errors.Is(err, ErrConflict) {
		t.Fatal("an edited finished occurrence was implicitly rearmed", err)
	}
	after, err := database.Snapshot(t.Context())
	if err != nil || after.Revision != before.Revision {
		t.Fatal("rejected rearming changed durable authority", err)
	}
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","at":4000}`), true); err != nil {
		t.Fatal("explicitly requested future occurrence was rejected", err)
	}
	after, err = database.Snapshot(t.Context())
	if err != nil || len(after.Items) != 1 {
		t.Fatal(err)
	}
	saved := after.Items[0]
	if saved.ID != record.ID || saved.Status != contracts.ScheduleStatusPending || saved.At != 4000 || saved.MessageID != nil || saved.DispatchedAt != nil || len(saved.RunHistory) != 1 || saved.RunHistory[0].MessageID != claim.Message.ID {
		t.Fatal("rearming lost the prior receipt or reused its execution identity", saved)
	}
	if len(boundary.Snapshot().Messages) != 1 {
		t.Fatal("editing a schedule materialized an additional message")
	}
}

func TestScheduleRecurringToOneOffEditRequiresItsOwnFutureTime(t *testing.T) {
	record := job(3000)
	record.Cron = contracts.Some("* * * * *")
	database := isolatedScheduleDatabase(t, record)
	scheduler, boundary := isolatedScheduler(t, database, nil)
	if err := boundary.Mutate(t.Context(), func(state *contracts.State) error {
		state.Settings.TimeZone = "Asia/Kuala_Lumpur"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	listed, err := scheduler.List(t.Context())
	if err != nil || listed.TimeZone != "Asia/Kuala_Lumpur" {
		t.Fatal("schedule listing ignored the configured time zone", listed, err)
	}
	for _, body := range []string{
		`{"id":"` + record.ID + `","cron":null}`,
		`{"id":"` + record.ID + `","cron":null,"at":1000}`,
	} {
		if _, err := scheduler.Save(t.Context(), json.RawMessage(body), true); !errors.Is(err, ErrInvalid) {
			t.Fatal("converting recurrence reused a stale occurrence time", err)
		}
	}
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","text":"same recurrence"}`), true); err != nil {
		t.Fatal("editing an unchanged recurrence was rejected", err)
	}
	if _, err := scheduler.Save(t.Context(), json.RawMessage(`{"id":"`+record.ID+`","cron":null,"at":5000}`), true); err != nil {
		t.Fatal("explicit one-off conversion was rejected", err)
	}
	snapshot, err := database.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 1 || snapshot.Items[0].Cron.Present && !snapshot.Items[0].Cron.Null || snapshot.Items[0].At != 5000 {
		t.Fatal("one-off conversion retained an active recurrence", snapshot, err)
	}
}
