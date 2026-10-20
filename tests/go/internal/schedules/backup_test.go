package schedules

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRestoredSchedulesRemainPausedAndUnknownHandoffsNeverReplay(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	first, second := job(1000), job(2000)
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	db, err := OpenDatabase(ctx, root, []json.RawMessage{a, b}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	claim := makeClaim(t, db, first, "old-owner")
	if ok, err := db.Claim(ctx, claim); err != nil || !ok {
		t.Fatal(err)
	}
	file := db.File()
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	beforeBytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateBackupDatabase(ctx, file); err != nil {
		t.Fatal(err)
	}
	afterBytes, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(beforeBytes, afterBytes) {
		t.Fatal("readonly validation changed schedule database")
	}
	if err = PauseRestoredDatabase(ctx, file); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(file)
	if !os.SameFile(before, after) {
		t.Fatal("database identity replaced")
	}
	snapshot, err := db.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range snapshot.Items {
		if item.Enabled == nil || *item.Enabled || item.ID == first.ID && item.Status != contracts.ScheduleStatusDispatched || item.ID == second.ID && item.Status != contracts.ScheduleStatusPaused {
			t.Fatal("restore made schedule runnable")
		}
	}
	held, err := db.RecoverPrepared(ctx, "new-owner", false)
	if err != nil || len(held) != 1 || held[0].Phase != contracts.ScheduleDispatchPhaseHeld || held[0].Message.ID != claim.Message.ID {
		t.Fatal("in-flight occurrence was not held", err)
	}
	if ok, err := db.FenceHandoff(ctx, claim.Message.ID, "old-owner"); err != nil || ok {
		t.Fatal("restored held dispatch became executable")
	}
	connection, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = connection.Exec("ALTER TABLE schedules ADD COLUMN unexpected TEXT"); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	connection.Close()
	if err = PauseRestoredDatabase(ctx, file); err == nil {
		t.Fatal("restore accepted drifted schema")
	}
	if err = ValidateBackupDatabase(ctx, file); err == nil {
		t.Fatal("readonly validation accepted drifted schema")
	}
}

func TestLegacyRecordPreservesObservedTextButMalformedFieldsNeverCoerce(t *testing.T) {
	raw := json.RawMessage(`{"id":"legacy","text":"authored\ud800text\u0000","at":1000,"status":"pending"}`)
	record, err := decodeRecord(raw)
	if err != nil {
		t.Fatal("legacy observation discarded", err)
	}
	encoded, err := json.Marshal(record)
	if err != nil || !strings.Contains(string(encoded), `\ud800`) {
		t.Fatal("legacy text changed")
	}
	for _, raw := range []string{`{"id":"a","text":null,"at":1000,"status":"pending"}`, `{"id":"a","text":"ok","at":null,"status":"pending"}`, `{"id":"a","text":"ok","at":1,"status":"pending","runHistory":[{}]}`, `{"id":"a","text":"ok","at":1,"status":"pending","runHistory":[{"messageId":"b","at":null}]}`} {
		if _, err := decodeRecord(json.RawMessage(raw)); err == nil {
			t.Fatal("malformed record accepted")
		}
	}
}
