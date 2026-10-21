package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScheduleClaimRejectsChangedOccurrenceAndRollsBackEveryFailedFence(t *testing.T) {
	for _, mode := range []string{"missing", "changed", "disabled", "invalid-message", "invalid-record", "duplicate-dispatch", "read-failure", "write-record", "write-dispatch", "write-revision"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			if mode == "disabled" {
				record.Enabled = schedulePointer(false)
			}
			db := isolatedScheduleDatabase(t, record)
			claim := makeClaim(t, db, record, "current-owner")
			wantErr := false
			switch mode {
			case "missing":
				claim.Candidate.ID = "no-such-schedule"
			case "changed":
				claim.Candidate.Text = "not the saved request"
			case "invalid-message":
				claim.Message.Role = contracts.RoleAssistant
				wantErr = true
			case "invalid-record":
				claim.Claimed.Extra = contracts.RawObject{"future": json.RawMessage(`{`)}
				wantErr = true
			case "duplicate-dispatch":
				data, _ := json.Marshal(claim.Message)
				scheduleSQL(t, db, "INSERT INTO schedule_dispatches VALUES(?,?,?,?,?,?)", claim.Message.ID, record.ID, int64(record.At), claim.Owner, contracts.ScheduleDispatchPhasePrepared, string(data))
			case "read-failure":
				scheduleSQL(t, db, "UPDATE schedules SET record_json=?", "false")
				snapshot, err := db.Snapshot(t.Context())
				if err == nil {
					t.Fatal("invalid row unexpectedly read", snapshot)
				}
				// Read the actual revision independently so Claim reaches and
				// rejects this persisted row, rather than only its stale fence.
				err = db.connection(t.Context(), func(connection *sql.DB) error {
					return connection.QueryRowContext(t.Context(), "SELECT revision FROM schedule_meta WHERE id=1").Scan(&claim.Revision)
				})
				if err != nil {
					t.Fatal(err)
				}
				wantErr = true
			case "write-record":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END")
				wantErr = true
			case "write-dispatch":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedule_dispatches BEGIN SELECT RAISE(ABORT,'synthetic dispatch fence failure'); END")
				wantErr = true
			case "write-revision":
				// The saved-record trigger increments once; failure on the next
				// revision proves both the dispatch and record roll back together.
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_meta WHEN NEW.revision>"+strconv.FormatInt(claim.Revision+1, 10)+" BEGIN SELECT RAISE(ABORT,'synthetic final fence failure'); END")
				wantErr = true
			}
			ok, err := db.Claim(t.Context(), claim)
			if ok || (err != nil) != wantErr {
				t.Fatal("invalid claim crossed its durable fence", ok, err)
			}
		})
	}
}

func TestScheduleDispatchMaterializationAndRecoveryNeverReplayFailedOrHeldOperations(t *testing.T) {
	for _, mode := range []string{"missing", "wrong-owner", "wrong-phase", "held-only", "operation-failure", "write-phase", "fence-write", "recovery-write", "invalid-dispatch"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			claim := makeClaim(t, db, record, "owner")
			if ok, err := db.Claim(t.Context(), claim); err != nil || !ok {
				t.Fatal(err)
			}
			calls := 0
			operation := func(dispatch Dispatch) error {
				calls++
				if dispatch.Message.ID != claim.Message.ID || dispatch.Owner != claim.Owner {
					t.Fatal("materialization changed its captured owner")
				}
				if mode == "operation-failure" {
					return ErrConflict
				}
				return nil
			}
			var ok bool
			var err error
			switch mode {
			case "missing":
				ok, err = db.Materialize(t.Context(), "missing", claim.Owner, operation)
			case "wrong-owner":
				ok, err = db.Materialize(t.Context(), claim.Message.ID, "retired-owner", operation)
			case "held-only":
				ok, err = db.MaterializeHeld(t.Context(), claim.Message.ID, operation)
			case "wrong-phase":
				if _, err := db.RecoverPrepared(t.Context(), "replacement", false); err != nil {
					t.Fatal(err)
				}
				ok, err = db.Materialize(t.Context(), claim.Message.ID, claim.Owner, operation)
			case "operation-failure":
				ok, err = db.Materialize(t.Context(), claim.Message.ID, claim.Owner, operation)
			case "write-phase", "fence-write", "recovery-write":
				if mode == "fence-write" {
					if applied, err := db.Materialize(t.Context(), claim.Message.ID, claim.Owner, func(Dispatch) error { return nil }); err != nil || !applied {
						t.Fatal(err)
					}
				}
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_dispatches BEGIN SELECT RAISE(ABORT,'synthetic dispatch write failure'); END")
				if mode == "write-phase" {
					ok, err = db.Materialize(t.Context(), claim.Message.ID, claim.Owner, operation)
				} else if mode == "fence-write" {
					ok, err = db.FenceHandoff(t.Context(), claim.Message.ID, claim.Owner)
				} else {
					_, err = db.RecoverPrepared(t.Context(), "new-owner", false)
				}
			case "invalid-dispatch":
				scheduleSQL(t, db, "UPDATE schedule_dispatches SET message_json=?", "false")
				ok, err = db.Materialize(t.Context(), claim.Message.ID, claim.Owner, operation)
				if _, readErr := db.RecoverPrepared(t.Context(), "new-owner", false); !errors.Is(readErr, ErrInvalid) {
					t.Fatal("corrupt dispatch became recoverable", readErr)
				}
			}
			wantFailure := mode == "operation-failure" || mode == "write-phase" || mode == "fence-write" || mode == "recovery-write" || mode == "invalid-dispatch"
			if ok || (err != nil) != wantFailure || calls > 1 {
				t.Fatal("failed dispatch crossed its fence or replayed", ok, calls, err)
			}
		})
	}
	db := isolatedScheduleDatabase(t)
	if _, err := db.RecoverPrepared(context.Background(), "bad owner", true); !errors.Is(err, ErrInvalid) {
		t.Fatal("malformed recovery owner accepted", err)
	}
}
