package backups

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func restoredStateFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "state.json"), []byte(cliFixtureState), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, data
}

func TestRestoredWorkerDisablesTelegramAndMarksUnconfirmedDeliveriesWithoutStartingAnything(t *testing.T) {
	root, data := restoredStateFixture(t)
	owner := filepath.Join(data, ".dant-core-owner.lock")
	if err := os.WriteFile(owner, []byte("synthetic former owner"), 0o600); err != nil {
		t.Fatal(err)
	}
	telegram := filepath.Join(data, "telegram.json")
	if err := os.WriteFile(telegram, []byte(`{"enabled":true,"outbox":[{"id":"queued","status":"queued"},{"id":"sending","status":"sending"},{"id":"sent","status":"sent"},null]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := PrepareRestoredWorkerState(t.Context(), root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(owner); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("restoration retained an old executor lock", err)
	}
	raw, err := os.ReadFile(telegram)
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Enabled bool
		Outbox  []struct{ ID, Status string }
	}
	if json.Unmarshal(raw, &value) != nil || value.Enabled || len(value.Outbox) != 4 || value.Outbox[0].Status != "unknown" || value.Outbox[1].Status != "unknown" || value.Outbox[2].Status != "sent" {
		t.Fatal("restored external delivery became enabled or retryable")
	}
	for _, status := range []string{"dispatched", "ready", "paused"} {
		raw, err := pauseScheduleJSON([]byte(`{"id":"synthetic","enabled":true,"status":"` + status + `"}`))
		if err != nil {
			t.Fatal(err)
		}
		var schedule struct {
			Enabled bool
			Status  string
		}
		if json.Unmarshal(raw, &schedule) != nil || schedule.Enabled || status == "dispatched" && schedule.Status != "dispatched" || status != "dispatched" && schedule.Status != "paused" {
			t.Fatal("restored schedule lost an existing dispatch receipt or resumed automatically")
		}
	}
}

func TestRestoredWorkerRejectsMalformedPrivateStateAndKeepsTheOriginalBytes(t *testing.T) {
	for _, mode := range []string{"missing-data", "missing-state", "invalid-state", "lock-directory", "invalid-memory", "invalid-schedules", "telegram-directory", "telegram-invalid", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			root, data := restoredStateFixture(t)
			ctx := t.Context()
			switch mode {
			case "missing-data":
				root = filepath.Join(root, "missing")
			case "missing-state":
				if err := os.Remove(filepath.Join(data, "state.json")); err != nil {
					t.Fatal(err)
				}
			case "invalid-state":
				if err := os.WriteFile(filepath.Join(data, "state.json"), []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "lock-directory":
				if err := os.Mkdir(filepath.Join(data, ".dant-core-owner.lock"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "invalid-memory", "invalid-schedules":
				name := filepath.Join(data, "memory", "dant", "memory.sqlite")
				if mode == "invalid-schedules" {
					name = filepath.Join(data, "schedules", "schedules.sqlite")
				}
				if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(name, []byte("synthetic invalid database"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "telegram-directory":
				if err := os.Mkdir(filepath.Join(data, "telegram.json"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "telegram-invalid":
				if err := os.WriteFile(filepath.Join(data, "telegram.json"), []byte("["), 0o600); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if err := PrepareRestoredWorkerState(ctx, root); !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid private restoration was accepted", err)
			}
		})
	}
	if _, err := pauseScheduleJSON([]byte("false")); !errors.Is(err, ErrInvalid) {
		t.Fatal("non-object restored schedule was accepted", err)
	}
}
