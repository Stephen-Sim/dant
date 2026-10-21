package schedules

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestScheduleRowVisitorStopsAtTheFirstConsumerFailureAndRejectsAnEndedTransaction(t *testing.T) {
	database := isolatedScheduleDatabase(t, job(1000), job(2000))
	connection, err := sql.Open("sqlite", database.File())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tx, err := connection.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	denied := errors.New("synthetic staged consumer failure")
	visited := 0
	if err := visitRecords(t.Context(), tx, func(record Record, raw json.RawMessage) error {
		visited++
		if record.ID == "" || !json.Valid(raw) {
			t.Fatal("consumer received an unvalidated persisted record")
		}
		return denied
	}); !errors.Is(err, denied) || visited != 1 {
		t.Fatal("consumer failure was lost or later records were consumed", visited, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := visitRecords(t.Context(), tx, func(Record, json.RawMessage) error {
		visited++
		return nil
	}); !errors.Is(err, sql.ErrTxDone) || visited != 1 {
		t.Fatal("ended transaction exposed records or hid its lifetime", visited, err)
	}
}

func TestScheduleRestorePausePreservesUnknownFieldsAndOriginalLegacyText(t *testing.T) {
	raw := json.RawMessage(`{"id":"legacy-fixture","text":"authored\ud800text\u0000","at":1000,"status":"pending","futureMetadata":{"version":7}}`)
	database, err := OpenDatabase(t.Context(), t.TempDir(), []json.RawMessage{raw}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := ValidateBackupDatabase(t.Context(), database.File()); err != nil {
		t.Fatal("compatible legacy backup was rejected", err)
	}
	if err := PauseRestoredDatabase(t.Context(), database.File()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := database.Snapshot(t.Context())
	if err != nil || len(snapshot.Items) != 1 {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(snapshot.Items[0])
	if err != nil || !strings.Contains(string(encoded), `"text":"authored\ud800text\u0000"`) || !strings.Contains(string(encoded), `"futureMetadata":{"version":7}`) || !strings.Contains(string(encoded), `"enabled":false`) || !strings.Contains(string(encoded), `"status":"paused"`) {
		t.Fatal("restore changed authored legacy text or compatible metadata", string(encoded), err)
	}
	if _, err := os.Stat(database.File() + "-journal"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("restore left an uncommitted database journal", err)
	}
}
