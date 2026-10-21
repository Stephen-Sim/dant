package schedules

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
)

func TestScheduleReadOnlyBackupRejectsBrokenMetadataConstraintsWithoutRepair(t *testing.T) {
	for _, test := range []struct {
		name, statement string
		arguments       []any
	}{
		{"imported-marker", "PRAGMA ignore_check_constraints=ON; UPDATE schedule_meta SET imported=2 WHERE id=1", nil},
		{"imported-blob", "PRAGMA ignore_check_constraints=ON; UPDATE schedule_meta SET imported=? WHERE id=1", []any{[]byte("1")}},
		{"unexpected-meta-id", "PRAGMA ignore_check_constraints=ON; INSERT INTO schedule_meta VALUES(2,0,0)", nil},
		{"revision-blob", "UPDATE schedule_meta SET revision=? WHERE id=1", []any{[]byte("1")}},
		{"negative-revision", "PRAGMA ignore_check_constraints=ON; UPDATE schedule_meta SET revision=-1 WHERE id=1", nil},
		{"oversized-revision", "UPDATE schedule_meta SET revision=9007199254740992 WHERE id=1", nil},
		{"missing-meta-row", "DELETE FROM schedule_meta", nil},
	} {
		for _, validation := range []struct {
			name string
			run  func(context.Context, string) error
		}{
			{"read-only", ValidateBackupDatabase},
			{"staged-restore", PauseRestoredDatabase},
		} {
			t.Run(test.name+"/"+validation.name, func(t *testing.T) {
				database := isolatedScheduleDatabase(t, job(1000))
				scheduleSQL(t, database, test.statement, test.arguments...)
				before, err := os.ReadFile(database.File())
				if err != nil {
					t.Fatal(err)
				}
				identity, err := os.Stat(database.File())
				if err != nil {
					t.Fatal(err)
				}
				if err := validation.run(t.Context(), database.File()); !errors.Is(err, ErrInvalid) {
					t.Error("broken metadata was accepted by backup validation or staged restore", err)
				}
				after, err := os.ReadFile(database.File())
				if err != nil {
					t.Fatal(err)
				}
				current, err := os.Stat(database.File())
				if err != nil || !bytes.Equal(before, after) || !identity.ModTime().Equal(current.ModTime()) || identity.Size() != current.Size() {
					t.Fatal("failed validation or staged restore repaired or replaced invalid metadata", err)
				}
			})
		}
	}
}
