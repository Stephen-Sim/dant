package schedules

import (
	"bytes"
	"errors"
	"os"
	"testing"
)

func TestScheduleRevisionLimitRejectsMutationBeforeCommitting(t *testing.T) {
	for _, operation := range []string{"replace", "claim", "staged-restore"} {
		t.Run(operation, func(t *testing.T) {
			record := job(1000)
			database := isolatedScheduleDatabase(t, record)
			scheduleSQL(t, database, "UPDATE schedule_meta SET revision=? WHERE id=1", maxRevision)
			before, err := os.ReadFile(database.File())
			if err != nil {
				t.Fatal(err)
			}

			switch operation {
			case "replace":
				record.Text = "Changed requested occurrence"
				err = database.Replace(t.Context(), maxRevision, []Record{record}, nil, nil)
			case "claim":
				claim := makeClaim(t, database, record, "fixture-owner")
				_, err = database.Claim(t.Context(), claim)
			case "staged-restore":
				if err := ValidateBackupDatabase(t.Context(), database.File()); err != nil {
					t.Fatal("maximum valid input revision was rejected", err)
				}
				err = PauseRestoredDatabase(t.Context(), database.File())
			}
			if !errors.Is(err, ErrInvalid) {
				t.Error("mutation committed an out-of-range schedule revision", err)
			}
			after, readErr := os.ReadFile(database.File())
			if readErr != nil || !bytes.Equal(before, after) {
				t.Error("rejected revision overflow left partial records or dispatches", readErr)
			}
			snapshot, snapshotErr := database.Snapshot(t.Context())
			if snapshotErr != nil || snapshot.Revision != maxRevision || len(snapshot.Items) != 1 || snapshot.Items[0].Text != "Requested fixture check" {
				t.Fatal("revision overflow invalidated the previously valid authority", snapshotErr)
			}
		})
	}
}

func TestScheduleRevisionLimitAllowsLastRepresentableMutation(t *testing.T) {
	for _, operation := range []string{"replace", "claim", "staged-restore"} {
		t.Run(operation, func(t *testing.T) {
			record := job(1000)
			database := isolatedScheduleDatabase(t, record)
			increment := int64(2)
			if operation == "staged-restore" {
				increment = 1
			}
			scheduleSQL(t, database, "UPDATE schedule_meta SET revision=? WHERE id=1", maxRevision-increment)

			var err error
			switch operation {
			case "replace":
				record.Text = "Changed requested occurrence"
				err = database.Replace(t.Context(), maxRevision-increment, []Record{record}, nil, nil)
			case "claim":
				claim := makeClaim(t, database, record, "fixture-owner")
				var claimed bool
				claimed, err = database.Claim(t.Context(), claim)
				if err == nil && !claimed {
					t.Fatal("last valid occurrence could not be claimed")
				}
			case "staged-restore":
				err = PauseRestoredDatabase(t.Context(), database.File())
			}
			if err != nil {
				t.Fatal("last representable mutation was rejected", err)
			}
			snapshot, err := database.Snapshot(t.Context())
			if err != nil || snapshot.Revision != maxRevision || len(snapshot.Items) != 1 {
				t.Fatal("last valid mutation produced an unreadable revision", snapshot.Revision, err)
			}
		})
	}
}
