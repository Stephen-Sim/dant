package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScheduleBackupRecordValidationPreservesUnknownFieldsAndRejectsDuplicateAuthority(t *testing.T) {
	request := "synthetic-request"
	first, second := job(1000), job(2000)
	first.ClientRequestID, second.ClientRequestID = &request, &request
	raw, _ := json.Marshal(first)
	other, _ := json.Marshal(second)
	for _, records := range [][]json.RawMessage{
		{json.RawMessage(`false`)}, {raw, raw}, {raw, other},
	} {
		if !errors.Is(ValidateBackupRecords(records), ErrInvalid) {
			t.Fatal("ambiguous backup identity was accepted")
		}
	}
	if err := ValidateBackupRecords([]json.RawMessage{raw}); err != nil {
		t.Fatal(err)
	}
	first.Extra = contracts.RawObject{"futureMetadata": json.RawMessage(`{"revision":7}`), "id": json.RawMessage(`"must-not-replace-authority"`)}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeRecord(encoded)
	if err != nil || decoded.ID != first.ID || string(decoded.Extra["futureMetadata"]) != `{"revision":7}` {
		t.Fatal("record round trip lost compatible metadata or overwrote its identity")
	}
	first.At = math.NaN()
	if _, err := json.Marshal(first); err == nil {
		t.Fatal("non-finite time was marshalled")
	}
	first = job(1000)
	first.Extra = contracts.RawObject{"futureMetadata": json.RawMessage(`{`)}
	if _, err := json.Marshal(first); err == nil {
		t.Fatal("invalid opaque metadata was marshalled as valid JSON")
	}
	for _, field := range []string{
		`"id":"\ud800"`, `"priority":"unknown"`, `"enabled":null`,
		`"runHistory":[null]`, `"runHistory":[{"messageId":null}]`,
		`"runHistory":[{"messageId":"message","workId":null}]`,
	} {
		body := `{"id":"fixture","text":"authored","at":1000,"status":"pending",` + field + `}`
		if _, err := decodeRecord(json.RawMessage(body)); !errors.Is(err, ErrInvalid) {
			t.Fatal("malformed record field lost validation", field, err)
		}
	}
}

func TestScheduleBackupValidationRejectsCorruptAuthorityWithoutRepairingOrCreatingIt(t *testing.T) {
	for _, mode := range []string{"missing", "directory", "hardlink", "cancelled", "bytes", "revision", "row-json", "row-id", "row-scan", "row-request", "tombstone", "dispatch"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			file, ctx := db.File(), t.Context()
			switch mode {
			case "missing":
				file += ".missing"
			case "directory":
				file = t.TempDir()
			case "hardlink":
				if err := os.Link(file, filepath.Join(t.TempDir(), "untrusted-link.sqlite")); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "bytes":
				if err := os.WriteFile(file, []byte("synthetic invalid SQLite"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "revision":
				scheduleSQL(t, db, "UPDATE schedule_meta SET revision=9007199254740992")
			case "row-json":
				scheduleSQL(t, db, "UPDATE schedules SET record_json=?", "null")
			case "row-id":
				scheduleSQL(t, db, "UPDATE schedules SET id=?", "different-record")
			case "row-scan":
				scheduleSQL(t, db, "UPDATE schedules SET id=NULL")
			case "row-request":
				scheduleSQL(t, db, "UPDATE schedules SET client_request_id=?", "unmatched-request")
			case "tombstone":
				scheduleSQL(t, db, "INSERT INTO schedule_tombstones VALUES(?)", "invalid request")
			case "dispatch":
				claim := makeClaim(t, db, record, "owner")
				if ok, err := db.Claim(ctx, claim); err != nil || !ok {
					t.Fatal(err)
				}
				scheduleSQL(t, db, "UPDATE schedule_dispatches SET message_json=?", "null")
			}
			before, beforeErr := os.ReadFile(file)
			if err := ValidateBackupDatabase(ctx, file); !errors.Is(err, ErrInvalid) {
				t.Fatal("corrupt backup was accepted", err)
			}
			after, afterErr := os.ReadFile(file)
			if (beforeErr == nil) != (afterErr == nil) || !reflect.DeepEqual(before, after) {
				t.Fatal("read-only backup validation repaired or created authority")
			}
		})
	}
}

func TestScheduleRestorePauseRejectsMalformedRowsAndRollsBackAllPartialWrites(t *testing.T) {
	for _, mode := range []string{"missing", "cancelled", "bytes", "missing-meta", "row-scan", "row-json", "write-record", "write-dispatch"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			ctx, file := t.Context(), db.File()
			switch mode {
			case "missing":
				file += ".missing"
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "bytes":
				if err := os.WriteFile(file, []byte("synthetic invalid SQLite"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "missing-meta":
				scheduleSQL(t, db, "DROP TABLE schedule_meta")
			case "row-scan":
				scheduleSQL(t, db, "UPDATE schedules SET id=NULL")
			case "row-json":
				scheduleSQL(t, db, "UPDATE schedules SET record_json=?", "null")
			case "write-record":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'synthetic staged write failure'); END")
			case "write-dispatch":
				claim := makeClaim(t, db, record, "owner")
				if ok, err := db.Claim(ctx, claim); err != nil || !ok {
					t.Fatal(err)
				}
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_dispatches BEGIN SELECT RAISE(ABORT,'synthetic staged handoff failure'); END")
			}
			before, beforeErr := os.ReadFile(file)
			if err := PauseRestoredDatabase(ctx, file); err == nil {
				t.Fatal("invalid staged database was reported as safely paused")
			}
			after, afterErr := os.ReadFile(file)
			if (beforeErr == nil) != (afterErr == nil) || !reflect.DeepEqual(before, after) {
				t.Fatal("failed restore pause left a partial change")
			}
		})
	}
	for _, id := range []string{"", strings.Repeat("x", 129), "contains space", "control\x7f"} {
		if validID(id) {
			t.Fatal("invalid schedule identity was accepted")
		}
	}
}
