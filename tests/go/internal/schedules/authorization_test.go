package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestSchedulerAuthorizationFencesOnlyTheFinalCommit(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	persistence, err := store.Open(directory, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	database, err := OpenDatabase(ctx, directory, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	scheduler, err := New(ctx, database, persistence, Options{
		Now:       func() time.Time { return time.UnixMilli(1000) },
		Available: func() bool { return true },
		Enqueue:   func(context.Context, *contracts.ChatMessage) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()
	denied := errors.New("fixture owner changed")
	calls := 0
	reject := func(context.Context, func(context.Context) error) error {
		calls++
		return denied
	}
	input := json.RawMessage(`{"text":"Fixture scheduled work","at":2000}`)
	if _, err := scheduler.SaveAuthorized(ctx, input, true, reject); !errors.Is(err, denied) {
		t.Fatal("stale owner saved a schedule", err)
	}
	snapshot, err := database.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 0 || len(persistence.Snapshot().Schedules) != 0 || calls != 1 {
		t.Fatal("denied save changed persistent state", err)
	}
	allow := func(commitContext context.Context, commit func(context.Context) error) error {
		if scheduler.mu.TryLock() {
			scheduler.mu.Unlock()
			t.Fatal("authorization ran before scheduler ownership")
		}
		calls++
		return commit(commitContext)
	}
	if _, err := scheduler.SaveAuthorized(ctx, input, true, allow); err != nil {
		t.Fatal("current owner could not commit", err)
	}
	snapshot, err = database.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 1 {
		t.Fatal("authorized save missing", err)
	}
	id, revision := snapshot.Items[0].ID, snapshot.Revision
	if _, err := scheduler.RemoveAuthorized(ctx, id, reject); !errors.Is(err, denied) {
		t.Fatal("stale owner removed a schedule", err)
	}
	snapshot, err = database.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 1 || snapshot.Revision != revision || calls != 3 {
		t.Fatal("denied removal changed the schedule", err)
	}
	if _, err := scheduler.RemoveAuthorized(ctx, id, allow); err != nil {
		t.Fatal("current owner could not remove", err)
	}
	snapshot, err = database.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 0 || len(persistence.Snapshot().Schedules) != 0 {
		t.Fatal("authorized removal did not synchronize persistence", err)
	}
}
