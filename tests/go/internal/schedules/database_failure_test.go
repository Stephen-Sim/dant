package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolatedScheduleDatabase(t *testing.T, records ...Record) *Database {
	t.Helper()
	legacy := make([]json.RawMessage, len(records))
	for index, record := range records {
		var err error
		legacy[index], err = json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
	}
	db, err := OpenDatabase(t.Context(), t.TempDir(), legacy, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func scheduleSQL(t *testing.T, db *Database, statement string, args ...any) {
	t.Helper()
	connection, err := sql.Open("sqlite", db.File())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := connection.ExecContext(t.Context(), statement, args...); err != nil {
		t.Fatal(err)
	}
}

func TestScheduleDatabaseRejectsClosedCancelledReplacedAndLinkedAuthorities(t *testing.T) {
	for _, mode := range []string{"closed", "cancelled", "missing-directory", "replaced-directory", "replaced-file", "hard-linked-file", "invalid-sidecar"} {
		t.Run(mode, func(t *testing.T) {
			db := isolatedScheduleDatabase(t)
			ctx := t.Context()
			want := ErrInvalid
			switch mode {
			case "closed":
				_ = db.Close()
				want = ErrUnavailable
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx, want = cancelled, context.Canceled
			case "missing-directory", "replaced-directory":
				if err := os.Rename(db.dir, db.dir+"-preserved"); err != nil {
					t.Fatal(err)
				}
				if mode == "replaced-directory" {
					if err := os.Mkdir(db.dir, 0o700); err != nil {
						t.Fatal(err)
					}
				}
			case "replaced-file":
				if err := os.Rename(db.file, db.file+".preserved"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(db.file, []byte("synthetic replacement"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "hard-linked-file":
				if err := os.Link(db.file, filepath.Join(filepath.Dir(db.dir), "linked-schedule.sqlite")); err != nil {
					t.Fatal(err)
				}
			case "invalid-sidecar":
				if err := os.Mkdir(db.file+"-journal", 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Snapshot(ctx); !errors.Is(err, want) {
				t.Fatal("changed authority was read or its failure lost classification", err)
			}
		})
	}
	for _, mode := range []string{"root-file", "database-directory", "database-hardlink", "version", "invalid-bytes"} {
		t.Run("open/"+mode, func(t *testing.T) {
			root := t.TempDir()
			if mode == "root-file" {
				root = filepath.Join(root, "not-directory")
				if err := os.WriteFile(root, []byte("synthetic file"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				directory := filepath.Join(root, "schedules")
				if err := os.Mkdir(directory, 0o700); err != nil {
					t.Fatal(err)
				}
				file := filepath.Join(directory, "schedules.sqlite")
				switch mode {
				case "database-directory":
					if err := os.Mkdir(file, 0o700); err != nil {
						t.Fatal(err)
					}
				case "database-hardlink", "invalid-bytes":
					if err := os.WriteFile(file, []byte("invalid database fixture"), 0o600); err != nil {
						t.Fatal(err)
					}
					if mode == "database-hardlink" {
						if err := os.Link(file, file+".linked"); err != nil {
							t.Fatal(err)
						}
					}
				case "version":
					scheduleSQL(t, &Database{file: file}, "PRAGMA user_version=99")
				}
			}
			if db, err := OpenDatabase(t.Context(), root, nil, nil); err == nil || db != nil {
				t.Fatal("invalid initial authority was accepted")
			}
		})
	}
}

func TestScheduleDatabaseSnapshotRejectsCorruptRowsSchemaAndRevisions(t *testing.T) {
	for _, mode := range []string{"row-json", "row-id", "row-scan", "row-request", "tombstone", "revision", "schema", "trigger"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			switch mode {
			case "row-json":
				scheduleSQL(t, db, "UPDATE schedules SET record_json=?", `{"invalid":true}`)
			case "row-id":
				scheduleSQL(t, db, "UPDATE schedules SET id=?", "changed-id")
			case "row-scan":
				scheduleSQL(t, db, "UPDATE schedules SET id=NULL")
			case "row-request":
				scheduleSQL(t, db, "UPDATE schedules SET client_request_id=?", "unmatched-request")
			case "tombstone":
				scheduleSQL(t, db, "INSERT INTO schedule_tombstones VALUES(?)", "bad id")
			case "revision":
				scheduleSQL(t, db, "UPDATE schedule_meta SET revision=9007199254740992")
			case "schema":
				scheduleSQL(t, db, "ALTER TABLE schedules ADD COLUMN unrecognized TEXT")
			case "trigger":
				scheduleSQL(t, db, "DROP TRIGGER schedules_schedules_insert")
			}
			if _, err := db.Snapshot(t.Context()); err == nil {
				t.Fatal("corrupted persisted schedule was projected as valid")
			}
		})
	}
}

func TestScheduleDatabaseReplaceRollsBackInvalidInputAndFailedCommits(t *testing.T) {
	for _, mode := range []string{"duplicate", "malformed", "oversized", "bad-tombstone", "commit-owner", "insert-failure", "delete-failure", "tombstone-failure", "revision-failure"} {
		t.Run(mode, func(t *testing.T) {
			record := job(1000)
			db := isolatedScheduleDatabase(t, record)
			before, err := db.Snapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			items, deleted := []Record{record}, []string{}
			var authorize func() error
			switch mode {
			case "duplicate":
				items = append(items, record)
			case "malformed":
				items[0].At = math.NaN()
			case "oversized":
				items[0].Text = strings.Repeat("x", MaxRecordBytes+1)
			case "bad-tombstone":
				deleted = []string{"invalid id"}
			case "commit-owner":
				authorize = func() error { return ErrConflict }
			case "insert-failure":
				items = append(items, job(2000))
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END")
			case "delete-failure":
				items = nil
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE DELETE ON schedules BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END")
			case "tombstone-failure":
				deleted = []string{"synthetic-request"}
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE INSERT ON schedule_tombstones BEGIN SELECT RAISE(ABORT,'synthetic tombstone failure'); END")
			case "revision-failure":
				items = nil
				// Removing the old row first would update the revision through its
				// required trigger. Keep the state empty before testing the final
				// metadata commit independently.
				if err := db.Replace(t.Context(), before.Revision, nil, nil, nil); err != nil {
					t.Fatal(err)
				}
				before, err = db.Snapshot(t.Context())
				if err != nil {
					t.Fatal(err)
				}
				scheduleSQL(t, db, "CREATE TRIGGER fixture_fail BEFORE UPDATE ON schedule_meta WHEN NEW.revision<>OLD.revision BEGIN SELECT RAISE(ABORT,'synthetic revision failure'); END")
			}
			if err := db.Replace(t.Context(), before.Revision, items, deleted, authorize); err == nil {
				t.Fatal("failed replacement was reported as committed")
			}
			after, err := db.Snapshot(t.Context())
			if err != nil || after.Revision != before.Revision || len(after.Items) != len(before.Items) || len(after.DeletedRequestIDs) != len(before.DeletedRequestIDs) {
				t.Fatal("failed replacement left a partial durable change", err)
			}
		})
	}
}
