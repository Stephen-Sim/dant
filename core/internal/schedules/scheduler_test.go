package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	conversation "github.com/Stephen-Sim/dant/core/internal/store"
)

func epoch(t *testing.T, value string) int64 {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.UnixMilli()
}

func TestCronPreservesSavedZoneDSTAndCalendarSemantics(t *testing.T) {
	for _, test := range []struct{ cron, after, zone, want string }{
		{"0 9 * * *", "2026-10-18T00:59:59.999Z", "Asia/Kuala_Lumpur", "2026-10-18T01:00:00.000Z"},
		{"0 9 * * *", "2026-10-18T01:00:00Z", "Asia/Kuala_Lumpur", "2026-10-19T01:00:00.000Z"},
		{"0 9 15 * mon", "2026-10-18T00:00:00Z", "UTC", "2026-10-19T09:00:00.000Z"},
		{"30 2 * * *", "2026-03-07T08:00:00Z", "America/New_York", "2026-03-09T06:30:00.000Z"},
		{"30 1 * * *", "2026-11-01T00:00:00Z", "America/New_York", "2026-11-01T05:30:00.000Z"},
		{"30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York", "2026-11-01T06:30:00.000Z"},
		{"15 2 * * *", "2026-10-03T16:00:00Z", "Australia/Lord_Howe", "2026-10-04T15:15:00.000Z"},
		{"0 0 29 2 *", "2096-03-01T00:00:00Z", "UTC", "2104-02-29T00:00:00.000Z"},
	} {
		got, err := NextAt(test.cron, epoch(t, test.after), test.zone)
		if err != nil || formatISO(got) != test.want {
			t.Fatalf("cron contract %s %s: %s %v", test.cron, test.zone, formatISO(got), err)
		}
	}
	for _, invalid := range []string{"", "@daily", "0 0 * *", "* * * * * *", "60 0 * * *", "*/0 * * * *", "*/61 * * * *", "1/2 * * * *", "5-1 * * * *", "1,,2 * * * *", "0 0 * * mon#2", "0 0 L * *"} {
		if _, err := ParseCron(invalid); err == nil {
			t.Fatal("invalid cron accepted")
		}
	}
	if _, err := NextAt("0 0 31 2 *", epoch(t, "2026-10-18T00:00:00Z"), "UTC"); err == nil {
		t.Fatal("impossible date was guessed")
	}
}

func job(at int64) Record {
	enabled := true
	zone := "UTC"
	return Record{ID: freshID(), Text: "Requested fixture check", At: float64(at), Status: contracts.ScheduleStatusPending, Enabled: &enabled, TimeZone: &zone, Priority: contracts.Some(contracts.TaskPriorityNormal), Cron: contracts.Null[string]()}
}

func makeClaim(t *testing.T, db *Database, candidate Record, owner string) Claim {
	t.Helper()
	snapshot, err := db.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	id := freshID()
	claimed := candidate
	claimed.Status = contracts.ScheduleStatusDispatched
	enabled := false
	claimed.Enabled = &enabled
	claimed.MessageID = &id
	claimed.LastRunAt = &candidate.At
	message := ScheduledMessage{id, contracts.RoleUser, candidate.Text, contracts.TaskStatusQueued, true, candidate.ID, int64(candidate.At), priority(candidate)}
	return Claim{snapshot.Revision, candidate, claimed, message, owner}
}

func TestSQLiteImportClaimsFencesAndRecoveryRetainExactIdentity(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	candidate := job(epoch(t, "2026-10-18T00:00:00Z"))
	request := freshID()
	candidate.ClientRequestID = &request
	raw, _ := json.Marshal(candidate)
	first, err := OpenDatabase(ctx, root, []json.RawMessage{raw}, []string{freshID()})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	matches, _ := filepath.Glob(filepath.Join(root, "schedules", "legacy-schedules-*.json"))
	if len(matches) != 1 {
		t.Fatal("legacy input not backed up")
	}
	second, err := OpenDatabase(ctx, root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	a := makeClaim(t, first, candidate, "worker-a")
	b := makeClaim(t, second, candidate, "worker-b")
	ok, err := first.Claim(ctx, a)
	if err != nil || !ok {
		t.Fatal(err)
	}
	ok, err = second.Claim(ctx, b)
	if err != nil || ok {
		t.Fatal("occurrence replay accepted", err)
	}
	if ok, err = first.Materialize(ctx, a.Message.ID, "wrong-owner", func(Dispatch) error { return nil }); err != nil || ok {
		t.Fatal("owner fence bypassed", err)
	}
	if ok, err = first.Materialize(ctx, a.Message.ID, a.Owner, func(Dispatch) error { return errors.New("isolated JSON persistence failure") }); err == nil || ok {
		t.Fatal("failed materialization committed")
	}
	held, err := second.RecoverPrepared(ctx, "restarted-owner", false)
	if err != nil || len(held) != 1 || held[0].Message.ID != a.Message.ID || held[0].Phase != contracts.ScheduleDispatchPhaseHeld {
		t.Fatal("recovery lost dispatch identity", err)
	}
	if ok, err = first.FenceHandoff(ctx, a.Message.ID, a.Owner); err != nil || ok {
		t.Fatal("held record replayed", err)
	}
	snapshot, _ := first.Snapshot(ctx)
	if err = first.Replace(ctx, snapshot.Revision, nil, []string{request}, nil); err != nil {
		t.Fatal(err)
	}
	third, err := OpenDatabase(ctx, root, []json.RawMessage{raw}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	snapshot, err = third.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 0 {
		t.Fatal("stale JSON resurrected schedule", err)
	}
}

func TestConcurrentDatabaseClaimsAndStaleMutationAreSerialized(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	candidate := job(1000)
	raw, _ := json.Marshal(candidate)
	first, err := OpenDatabase(ctx, root, []json.RawMessage{raw}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := OpenDatabase(ctx, root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	a, b := makeClaim(t, first, candidate, "owner-a"), makeClaim(t, second, candidate, "owner-b")
	var wait sync.WaitGroup
	results := make(chan bool, 2)
	failures := make(chan error, 2)
	for index, db := range []*Database{first, second} {
		claim := a
		if index == 1 {
			claim = b
		}
		wait.Add(1)
		go func(db *Database, claim Claim) {
			defer wait.Done()
			ok, err := db.Claim(ctx, claim)
			results <- ok
			failures <- err
		}(db, claim)
	}
	wait.Wait()
	close(results)
	close(failures)
	count := 0
	for ok := range results {
		if ok {
			count++
		}
	}
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatal("single occurrence was claimed more than once")
	}
	if err = first.Replace(ctx, a.Revision, nil, nil, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("stale deletion did not conflict", err)
	}
}

func TestSchedulerDispatchAndUnknownHandoffNeverReplay(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	now := epoch(t, "2026-10-18T00:00:00Z")
	state, err := conversation.Open(root, conversation.Options{Now: func() time.Time { return time.UnixMilli(now) }})
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	database, err := OpenDatabase(ctx, root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	available := false
	calls := 0
	scheduler, err := New(ctx, database, state, Options{Now: func() time.Time { return time.UnixMilli(now) }, Available: func() bool { return available }, Enqueue: func(context.Context, *contracts.ChatMessage) error {
		calls++
		return errors.New("unknown fixture outcome")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()
	raw, err := scheduler.Save(ctx, json.RawMessage(`{"text":"requested fixture","at":"2026-10-18T00:01:00Z","timeZone":"UTC"}`), false)
	if err != nil {
		t.Fatal(err)
	}
	var view struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &view) != nil {
		t.Fatal("invalid save result")
	}
	if calls != 0 {
		t.Fatal("save executed work")
	}
	now += 120000
	if result, err := scheduler.Tick(ctx); err != nil || len(result) != 0 {
		t.Fatal("offline dispatched", err)
	}
	available = true
	if _, err = scheduler.Tick(ctx); err == nil || calls != 1 {
		t.Fatal("unknown handoff not surfaced")
	}
	if _, err = scheduler.Tick(ctx); err != nil || calls != 1 {
		t.Fatal("unknown outcome replayed", err)
	}
	restarted, err := New(ctx, database, state, Options{Available: func() bool { return true }, Now: func() time.Time { return time.UnixMilli(now) }, Enqueue: func(context.Context, *contracts.ChatMessage) error { calls++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if _, err = restarted.Tick(ctx); err != nil || calls != 1 {
		t.Fatal("restart replayed fence", err)
	}
	messages := state.Snapshot().Messages
	if len(messages) != 1 || messages[0].ScheduleID != view.ID {
		t.Fatal("materialization identity changed")
	}
}

func TestRecurringCatchUpWaitsForUnfinishedWorkAndDeletionTombstone(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	now := epoch(t, "2026-10-18T00:00:00Z")
	state, err := conversation.Open(root, conversation.Options{Now: func() time.Time { return time.UnixMilli(now) }})
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	database, err := OpenDatabase(ctx, root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	calls := 0
	scheduler, err := New(ctx, database, state, Options{Now: func() time.Time { return time.UnixMilli(now) }, Available: func() bool { return true }, Enqueue: func(context.Context, *contracts.ChatMessage) error { calls++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()
	request := freshID()
	body := json.RawMessage(`{"text":"recurring fixture","cron":"0 9 * * *","timeZone":"Asia/Kuala_Lumpur","clientRequestId":"` + request + `"}`)
	saved, err := scheduler.Save(ctx, body, true)
	if err != nil {
		t.Fatal(err)
	}
	again, err := scheduler.Save(ctx, body, true)
	if err != nil || string(saved) != string(again) {
		t.Fatal("idempotent creation changed", err)
	}
	now += 5 * 86400000
	if result, err := scheduler.Tick(ctx); err != nil || len(result) != 1 || calls != 1 {
		t.Fatal("catch-up failed", err)
	}
	now += 2 * 86400000
	if result, err := scheduler.Tick(ctx); err != nil || len(result) != 0 || calls != 1 {
		t.Fatal("unfinished recurrence overlapped", err)
	}
	snapshot, _ := database.Snapshot(ctx)
	if len(snapshot.Items) != 1 {
		t.Fatal("schedule lost")
	}
	id := snapshot.Items[0].ID
	if _, err = scheduler.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err = scheduler.Save(ctx, body, true); !errors.Is(err, ErrConflict) {
		t.Fatal("deleted creation replayed", err)
	}
	if _, err = os.Stat(filepath.Join(root, "schedules", "schedules.sqlite")); err != nil {
		t.Fatal("database path changed")
	}
	if strings.Contains(string(saved), "creationFingerprint") {
		t.Fatal("private idempotency fingerprint exposed")
	}
}
