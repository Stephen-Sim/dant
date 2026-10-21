package schedules

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	_ "modernc.org/sqlite"
)

const maxRevision int64 = 1<<53 - 1

type directory struct {
	path     string
	identity fs.FileInfo
}

type Database struct {
	mu          sync.Mutex
	file, dir   string
	identity    fs.FileInfo
	directories []directory
	closed      bool
}

func freshID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("secure identity unavailable")
	}
	value[6] = value[6]&15 | 64
	value[8] = value[8]&63 | 128
	s := hex.EncodeToString(value[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func OpenDatabase(ctx context.Context, dataDir string, legacy []json.RawMessage, deleted []string) (*Database, error) {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, ErrInvalid
	}
	db := &Database{dir: filepath.Join(root, "schedules")}
	for _, path := range []string{root, db.dir} {
		if err = os.MkdirAll(path, 0700); err != nil {
			return nil, ErrUnavailable
		}
		stat, err := files.CaptureIdentity(path)
		if err != nil || !stat.IsDir() || linked(stat) {
			return nil, ErrInvalid
		}
		db.directories = append(db.directories, directory{path, stat})
	}
	db.file = filepath.Join(db.dir, "schedules.sqlite")
	handle, err := os.OpenFile(db.file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		err = handle.Close()
	} else if errors.Is(err, fs.ErrExist) {
		err = nil
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	db.identity, err = os.Lstat(db.file)
	if err != nil || !db.identity.Mode().IsRegular() || linked(db.identity) || !singleLink(db.file, db.identity) {
		return nil, ErrInvalid
	}
	err = db.connection(ctx, func(connection *sql.DB) error { return db.initialize(ctx, connection, legacy, deleted) })
	if err != nil {
		return nil, err
	}
	return db, nil
}

func (db *Database) File() string { return db.file }
func (db *Database) Close() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.closed = true
	return nil
}
func (db *Database) guard() error {
	if db.closed {
		return ErrUnavailable
	}
	for _, directory := range db.directories {
		stat, err := os.Lstat(directory.path)
		if err != nil || !stat.IsDir() || linked(stat) || !os.SameFile(directory.identity, stat) {
			return ErrInvalid
		}
	}
	stat, err := os.Lstat(db.file)
	if err != nil || !stat.Mode().IsRegular() || linked(stat) || !singleLink(db.file, stat) || !os.SameFile(db.identity, stat) {
		return ErrInvalid
	}
	for _, suffix := range []string{"-journal", "-wal", "-shm"} {
		stat, err := os.Lstat(db.file + suffix)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil || !stat.Mode().IsRegular() || linked(stat) || !singleLink(db.file+suffix, stat) {
			return ErrInvalid
		}
	}
	return nil
}

func (db *Database) connection(ctx context.Context, operation func(*sql.DB) error) error {
	if err := db.guard(); err != nil {
		return err
	}
	connection, err := sql.Open("sqlite", db.file)
	if err != nil {
		return ErrUnavailable
	}
	defer connection.Close()
	connection.SetMaxOpenConns(1)
	if _, err = connection.ExecContext(ctx, "PRAGMA busy_timeout=5000;PRAGMA trusted_schema=OFF;PRAGMA synchronous=FULL;"); err == nil {
		err = operation(connection)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		for _, known := range []error{ErrInvalid, ErrConflict, ErrNotFound} {
			if errors.Is(err, known) {
				return known
			}
		}
		return ErrUnavailable
	}
	return db.guard()
}

func scheduleTrigger(table, action string) string {
	return "CREATE TRIGGER schedules_" + table + "_" + strings.ToLower(action) + " AFTER " + action + " ON " + table + " BEGIN UPDATE schedule_meta SET revision=revision+1 WHERE id=1; END"
}

func (db *Database) initialize(ctx context.Context, connection *sql.DB, legacy []json.RawMessage, deleted []string) error {
	var version int
	if err := connection.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 0 && version != 1 {
		return ErrInvalid
	}
	if _, err := connection.ExecContext(ctx, "PRAGMA journal_mode=DELETE"); err != nil {
		return err
	}
	tx, err := connection.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	schema := `CREATE TABLE IF NOT EXISTS schedule_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), imported INTEGER NOT NULL CHECK(imported IN (0,1)));
 INSERT OR IGNORE INTO schedule_meta VALUES(1,0,0);
 CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, client_request_id TEXT UNIQUE, record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) <= 1048576));
 CREATE TABLE IF NOT EXISTS schedule_tombstones (request_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS schedule_dispatches (message_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','materialized','held','handed-off')), message_json TEXT NOT NULL, UNIQUE(schedule_id,scheduled_at)); PRAGMA user_version=1;`
	if _, err = tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	for _, table := range []string{"schedules", "schedule_tombstones"} {
		for _, action := range []string{"INSERT", "UPDATE", "DELETE"} {
			if _, err = tx.ExecContext(ctx, strings.Replace(scheduleTrigger(table, action), "CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ", 1)); err != nil {
				return err
			}
		}
	}
	var imported int
	if err = tx.QueryRowContext(ctx, "SELECT imported FROM schedule_meta WHERE id=1").Scan(&imported); err != nil {
		return err
	}
	if imported != 1 {
		if len(legacy) > 0 || len(deleted) > 0 {
			data, _ := json.Marshal(struct {
				Schedules []json.RawMessage `json:"schedules"`
				Deleted   []string          `json:"deletedRequestIds"`
			}{legacy, deleted})
			if err = db.backup(data); err != nil {
				return err
			}
		}
		for _, raw := range legacy {
			record, decodeErr := decodeRecord(raw)
			if decodeErr != nil {
				continue
			}
			if err = put(ctx, tx, record); err != nil {
				return err
			}
		}
		for _, id := range deleted {
			if validID(id) {
				if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO schedule_tombstones VALUES(?)", id); err != nil {
					return err
				}
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE schedule_meta SET imported=1,revision=revision+1 WHERE id=1"); err != nil {
			return err
		}
	}
	if err = validateSchema(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	var check string
	if err = connection.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return ErrInvalid
	}
	return nil
}

func (db *Database) backup(data []byte) error {
	file := filepath.Join(db.dir, "legacy-schedules-"+freshID()+".json")
	handle, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = handle.Write(data)
	if err == nil {
		err = handle.Sync()
	}
	closed := handle.Close()
	if err != nil {
		return err
	}
	return closed
}

func validateSchema(ctx context.Context, tx *sql.Tx) error {
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		return ErrInvalid
	}
	for table, expected := range map[string][]string{
		"schedule_meta": {"id", "revision", "imported"}, "schedules": {"id", "client_request_id", "record_json"},
		"schedule_tombstones": {"request_id"}, "schedule_dispatches": {"message_id", "schedule_id", "scheduled_at", "owner", "phase", "message_json"},
	} {
		rows, err := tx.QueryContext(ctx, "SELECT name FROM pragma_table_info(?) ORDER BY cid", table)
		if err != nil {
			return ErrInvalid
		}
		actual := []string{}
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				rows.Close()
				return ErrInvalid
			}
			actual = append(actual, name)
		}
		err = rows.Err()
		rows.Close()
		if err != nil || strings.Join(actual, "\x00") != strings.Join(expected, "\x00") {
			return ErrInvalid
		}
	}
	for _, table := range []string{"schedules", "schedule_tombstones"} {
		for _, action := range []string{"INSERT", "UPDATE", "DELETE"} {
			var saved string
			if err := tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", "schedules_"+table+"_"+strings.ToLower(action)).Scan(&saved); err != nil || saved != scheduleTrigger(table, action) {
				return ErrInvalid
			}
		}
	}
	return validateMetadata(ctx, tx)
}

func validateMetadata(ctx context.Context, tx *sql.Tx) error {
	var invalid bool
	err := tx.QueryRowContext(ctx, `SELECT
 NOT EXISTS(SELECT 1 FROM schedule_meta WHERE id=1) OR
 EXISTS(SELECT 1 FROM schedule_meta WHERE id<>1 OR
 typeof(revision)<>'integer' OR revision<0 OR revision>? OR
 typeof(imported)<>'integer' OR imported NOT IN (0,1))`, maxRevision).Scan(&invalid)
	if err != nil || invalid {
		return ErrInvalid
	}
	return nil
}

func (db *Database) transaction(ctx context.Context, operation func(*sql.Tx) error) error {
	return db.connection(ctx, func(connection *sql.DB) error {
		tx, err := connection.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, "UPDATE schedule_meta SET revision=revision WHERE id=1"); err != nil {
			return err
		}
		if err = validateSchema(ctx, tx); err != nil {
			return err
		}
		if err = operation(tx); err != nil {
			return err
		}
		if err = validateMetadata(ctx, tx); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func revision(ctx context.Context, tx *sql.Tx) (int64, error) {
	var value int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM schedule_meta WHERE id=1").Scan(&value); err != nil || value < 0 || value > maxRevision {
		return 0, ErrInvalid
	}
	return value, nil
}

func put(ctx context.Context, tx *sql.Tx, record Record) error {
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > MaxRecordBytes {
		return ErrInvalid
	}
	if _, err = decodeRecord(raw); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO schedules(id,client_request_id,record_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET client_request_id=excluded.client_request_id,record_json=excluded.record_json", record.ID, record.ClientRequestID, string(raw))
	return err
}

func (db *Database) Snapshot(ctx context.Context) (Snapshot, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	result := Snapshot{Items: []Record{}, DeletedRequestIDs: []string{}}
	err := db.transaction(ctx, func(tx *sql.Tx) error {
		var err error
		result.Revision, err = revision(ctx, tx)
		if err != nil {
			return err
		}
		err = visitRecords(ctx, tx, func(record Record, _ json.RawMessage) error {
			result.Items = append(result.Items, record)
			return nil
		})
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT request_id FROM schedule_tombstones ORDER BY rowid")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil || !validID(id) {
				return ErrInvalid
			}
			result.DeletedRequestIDs = append(result.DeletedRequestIDs, id)
		}
		return rows.Err()
	})
	return result, err
}

func (db *Database) Replace(ctx context.Context, expected int64, items []Record, deleted []string, beforeCommit func() error) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.transaction(ctx, func(tx *sql.Tx) error {
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if current != expected {
			return ErrConflict
		}
		keep := map[string]bool{}
		for _, item := range items {
			if keep[item.ID] {
				return ErrInvalid
			}
			if err = put(ctx, tx, item); err != nil {
				return err
			}
			keep[item.ID] = true
		}
		rows, err := tx.QueryContext(ctx, "SELECT id FROM schedules")
		if err != nil {
			return err
		}
		remove := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			if !keep[id] {
				remove = append(remove, id)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, id := range remove {
			if _, err = tx.ExecContext(ctx, "DELETE FROM schedules WHERE id=?", id); err != nil {
				return err
			}
		}
		for _, id := range deleted {
			if !validID(id) {
				return ErrInvalid
			}
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO schedule_tombstones VALUES(?)", id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE schedule_meta SET revision=revision+1 WHERE id=1"); err != nil {
			return err
		}
		if beforeCommit != nil {
			return beforeCommit()
		}
		return nil
	})
}

func (db *Database) Claim(ctx context.Context, claim Claim) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	claimed := false
	err := db.transaction(ctx, func(tx *sql.Tx) error {
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if current != claim.Revision {
			return nil
		}
		var raw string
		if err = tx.QueryRowContext(ctx, "SELECT record_json FROM schedules WHERE id=?", claim.Candidate.ID).Scan(&raw); err == sql.ErrNoRows {
			return nil
		} else if err != nil {
			return err
		}
		saved, err := decodeRecord(json.RawMessage(raw))
		if err != nil {
			return err
		}
		a, _ := json.Marshal(saved)
		b, _ := json.Marshal(claim.Candidate)
		if string(a) != string(b) || saved.Status != contracts.ScheduleStatusPending || saved.Enabled != nil && !*saved.Enabled || !validInstant(saved.At) {
			return nil
		}
		message := claim.Message
		if !message.valid() || !validID(claim.Owner) || message.ScheduleID != saved.ID || message.ScheduledAt != int64(saved.At) || message.Text != saved.Text || message.ProgressPriority != priority(saved) || claim.Claimed.ID != saved.ID || claim.Claimed.MessageID == nil || *claim.Claimed.MessageID != message.ID || claim.Claimed.Text != saved.Text || claim.Claimed.LastRunAt == nil || *claim.Claimed.LastRunAt != saved.At {
			return ErrInvalid
		}
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM schedule_dispatches WHERE schedule_id=? AND scheduled_at=?", saved.ID, saved.At).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			return nil
		}
		if err = put(ctx, tx, claim.Claimed); err != nil {
			return err
		}
		data, _ := json.Marshal(message)
		if _, err = tx.ExecContext(ctx, "INSERT INTO schedule_dispatches VALUES(?,?,?,?,?,?)", message.ID, saved.ID, message.ScheduledAt, claim.Owner, string(contracts.ScheduleDispatchPhasePrepared), string(data)); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE schedule_meta SET revision=revision+1 WHERE id=1"); err != nil {
			return err
		}
		claimed = true
		return nil
	})
	return claimed, err
}
