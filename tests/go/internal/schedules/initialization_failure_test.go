package schedules

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestScheduleLegacyInitializationRollsBackEveryFailedPersistentStage(t *testing.T) {
	for _, mode := range []string{"schema-write", "trigger-create", "imported-scan", "record-insert", "tombstone-insert", "imported-write", "schema-validation"} {
		t.Run(mode, func(t *testing.T) {
			db := isolatedScheduleDatabase(t)
			scheduleSQL(t, db, "UPDATE schedule_meta SET imported=0")
			record := job(1000)
			raw, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			legacy := []json.RawMessage{raw}
			deleted := []string{"retained-request"}
			switch mode {
			case "schema-write":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedule_meta BEGIN SELECT RAISE(ABORT,'synthetic schema insertion failed'); END")
			case "trigger-create":
				scheduleSQL(t, db, "DROP TABLE schedules; CREATE VIEW schedules AS SELECT 'synthetic-id' AS id, NULL AS client_request_id, '{}' AS record_json")
			case "imported-scan":
				scheduleSQL(t, db, "ALTER TABLE schedule_meta RENAME TO retained_meta; CREATE TABLE schedule_meta(id INTEGER PRIMARY KEY,revision INTEGER,imported TEXT); INSERT INTO schedule_meta VALUES(1,1,'invalid imported flag')")
			case "record-insert":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'synthetic legacy record insertion failed'); END")
			case "tombstone-insert":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedule_tombstones BEGIN SELECT RAISE(ABORT,'synthetic tombstone insertion failed'); END")
			case "imported-write":
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_meta WHEN NEW.imported=1 BEGIN SELECT RAISE(ABORT,'synthetic import publication failed'); END")
			case "schema-validation":
				scheduleSQL(t, db, "ALTER TABLE schedules ADD COLUMN unrecognized TEXT")
			}
			if opened, err := OpenDatabase(t.Context(), filepath.Dir(db.dir), legacy, deleted); err == nil || opened != nil {
				if opened != nil {
					opened.Close()
				}
				t.Fatal("failed initialization published an executable schedule database")
			}
			connection, err := sql.Open("sqlite", db.file)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			if mode != "schema-write" && mode != "trigger-create" && mode != "imported-scan" {
				var count int
				if err := connection.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM schedules").Scan(&count); err != nil || count != 0 {
					t.Fatal("failed initialization left a partially imported schedule", err)
				}
				if err := connection.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM schedule_tombstones").Scan(&count); err != nil || count != 0 {
					t.Fatal("failed initialization left partial deletion receipts", err)
				}
				if err := connection.QueryRowContext(t.Context(), "SELECT imported FROM schedule_meta WHERE id=1").Scan(&count); err != nil || count != 0 {
					t.Fatal("failed initialization falsely published an import completion", err)
				}
				copies, err := filepath.Glob(filepath.Join(db.dir, "legacy-schedules-*.json"))
				if err != nil || len(copies) != 1 {
					t.Fatal("failed import lost the independently saved legacy source", err)
				}
				backup, err := os.ReadFile(copies[0])
				if err != nil || !bytes.Contains(backup, raw) || !bytes.Contains(backup, []byte("retained-request")) {
					t.Fatal("legacy source backup did not retain original records and deletion identities", err)
				}
			}
		})
	}
}

func TestScheduleLegacyInitializationPreservesInvalidRecordsWithoutAdmittingThem(t *testing.T) {
	root := t.TempDir()
	legacy := []json.RawMessage{json.RawMessage(`false`), json.RawMessage(`{"id":"incomplete-legacy-record"}`)}
	db, err := OpenDatabase(t.Context(), root, legacy, []string{"invalid request id"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	snapshot, err := db.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 0 || len(snapshot.DeletedRequestIDs) != 0 {
		t.Fatal("invalid legacy metadata was normalized into an executable occurrence", err)
	}
	copies, err := filepath.Glob(filepath.Join(db.dir, "legacy-schedules-*.json"))
	if err != nil || len(copies) != 1 {
		t.Fatal("invalid legacy input was discarded without preserving its original backup", err)
	}
	raw, err := os.ReadFile(copies[0])
	if err != nil || !bytes.Contains(raw, legacy[0]) || !bytes.Contains(raw, legacy[1]) {
		t.Fatal("legacy backup lost raw unsupported records", err)
	}
}

func TestScheduleInitializationRejectsCorruptionOutsideTheImportedTables(t *testing.T) {
	db := isolatedScheduleDatabase(t)
	scheduleSQL(t, db, "CREATE TABLE unread_fixture(value TEXT); INSERT INTO unread_fixture VALUES('preserved original bytes')")
	connection, err := sql.Open("sqlite", db.file)
	if err != nil {
		t.Fatal(err)
	}
	var page, pageSize int64
	if err := connection.QueryRowContext(t.Context(), "SELECT rootpage FROM sqlite_schema WHERE name='unread_fixture'").Scan(&page); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	if err := connection.QueryRowContext(t.Context(), "PRAGMA page_size").Scan(&pageSize); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	connection.Close()
	if page <= 1 || pageSize <= 0 {
		t.Fatal("corruption fixture has no independently allocated B-tree page")
	}
	file, err := os.OpenFile(db.file, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte{255}, (page-1)*pageSize); err != nil {
		file.Close()
		t.Fatal(err)
	}
	file.Close()
	original, err := os.ReadFile(db.file)
	if err != nil {
		t.Fatal(err)
	}
	for _, validate := range []func(context.Context, string) error{ValidateBackupDatabase, PauseRestoredDatabase} {
		if err := validate(t.Context(), db.file); !errors.Is(err, ErrInvalid) {
			t.Fatal("restore validation ignored corruption in another persisted table", err)
		}
		current, err := os.ReadFile(db.file)
		if err != nil || !bytes.Equal(current, original) {
			t.Fatal("failed integrity validation changed staged database bytes", err)
		}
	}
	if opened, err := OpenDatabase(t.Context(), filepath.Dir(db.dir), nil, nil); !errors.Is(err, ErrInvalid) || opened != nil {
		if opened != nil {
			opened.Close()
		}
		t.Fatal("schema-compatible corruption bypassed the final database integrity check", err)
	}
}
