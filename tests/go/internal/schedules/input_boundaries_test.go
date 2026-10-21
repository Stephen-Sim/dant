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

func TestScheduleInputValidationCannotCreatePartialRecords(t *testing.T) {
	directory := t.TempDir()
	persistence, err := store.Open(directory, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	database, err := OpenDatabase(t.Context(), directory, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	scheduler, err := New(t.Context(), database, persistence, Options{Now: func() time.Time { return time.UnixMilli(1000) }, Available: func() bool { return true }, Enqueue: func(context.Context, *contracts.ChatMessage) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()
	for _, body := range []string{
		`null`, `{`, `{"unknown":true}`, `{"id":false}`, `{"id":"missing"}`, `{"clientRequestId":null}`, `{"clientRequestId":"not-uuid"}`, `{"text":null}`, `{"text":false}`, `{"text":""}`, `{"text":"a\u0000b"}`, `{"text":"request","cron":false}`, `{"text":"request","cron":"bad"}`, `{"text":"request","cron":"* * * * *","at":2000}`, `{"text":"request","priority":"invalid"}`, `{"text":"request","timeZone":false}`, `{"text":"request","timeZone":"bad/zone"}`, `{"text":"request","enabled":null}`, `{"text":"request","enabled":false,"at":false}`, `{"text":"request","enabled":"false"}`, `{"text":"request"}`, `{"text":"request","at":1000}`,
	} {
		if _, err := scheduler.Save(t.Context(), json.RawMessage(body), true); err == nil {
			t.Fatal("invalid scheduling request was accepted")
		}
	}
	if _, err := scheduler.SaveAuthorized(t.Context(), json.RawMessage(`{}`), true, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing commit authorization accepted", err)
	}
	if _, err := scheduler.RemoveAuthorized(t.Context(), "any", nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing removal authorization accepted", err)
	}
	if _, err := scheduler.Remove(t.Context(), "bad id"); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid removal identity accepted", err)
	}
	if _, err := scheduler.Remove(t.Context(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing schedule was removed", err)
	}
	if _, err := scheduler.Get(t.Context(), ""); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid read identity accepted", err)
	}
	if _, err := scheduler.Get(t.Context(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing schedule was invented", err)
	}
	if result, err := scheduler.List(t.Context()); err != nil || len(result.Items) != 0 || result.TimeZone != "UTC" {
		t.Fatal("rejected requests left partial saved records", result, err)
	}
	scheduler.Start(t.Context())
	scheduler.Start(t.Context())
	if err := scheduler.Close(); err != nil {
		t.Fatal(err)
	}
	scheduler.Start(t.Context())
	if dispatched, err := scheduler.Tick(t.Context()); err != nil || len(dispatched) != 0 {
		t.Fatal("closed scheduler admitted work", err)
	}
	for _, options := range []Options{{}, {Available: func() bool { return true }}, {Available: func() bool { return true }, Enqueue: func(context.Context, *contracts.ChatMessage) error { return nil }, NewID: func() string { return "" }}} {
		if _, err := New(t.Context(), database, persistence, options); !errors.Is(err, ErrInvalid) {
			t.Fatal("incomplete scheduler dependencies accepted", err)
		}
	}
}

func TestScheduleInstantParserRejectsMalformedOrUnrepresentableDates(t *testing.T) {
	for _, raw := range []string{`false`, `"2026-01-01"`, `"2026-01-01T01:00+24:00"`, `"2026-01-01T01:00+00:60"`, `"0099-01-01T01:00Z"`, `"2026-02-30T01:00Z"`, `"0000-01-01T00:00Z"`} {
		if _, err := inputInstant(json.RawMessage(raw), false); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid authored date was accepted", err)
		}
	}
	if at, err := inputInstant(json.RawMessage(`"2026-01-01T01:00Z"`), false); err != nil || at != time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatal("minute-precision ISO input lost its explicit zone", at, err)
	}
	if formatISO(time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()) != "+010000-01-01T00:00:00.000Z" || formatISO(time.Date(-100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()) != "-000100-01-01T00:00:00.000Z" {
		t.Fatal("extended-year serialization changed signed ISO syntax")
	}
}
