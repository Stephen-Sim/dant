package settings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestAppearanceValidationImportAndDefaultsRemainCompatible(t *testing.T) {
	defaults := ReadAppearance(json.RawMessage(`{"theme":"unknown","fontSize":1,"fontFamily":"  Segoe UI  ","accentColor":"#aaBBcc"}`))
	if defaults.Theme != "system" || defaults.FontSize != 13 || defaults.FontFamily != "Segoe UI" || defaults.AccentColor == nil || *defaults.AccentColor != "#AABBCC" {
		t.Fatal("appearance defaults or normalization changed")
	}
	for _, raw := range []string{`{"fontSize":null}`, `{"fontSize":13.5}`, `{"theme":"unknown"}`, `{"accentColor":"#123"}`, `{"fontFamily":"unsafe;css"}`, `null`} {
		if _, err := ValidateAppearancePatch(json.RawMessage(raw)); !errors.Is(err, ErrInvalidAppearance) {
			t.Fatal("invalid preference accepted", err)
		}
	}
	exported, err := ExportAppearance(json.RawMessage(`{"theme":"dark","fontSize":14}`))
	if err != nil {
		t.Fatal(err)
	}
	patch, err := ImportAppearance(exported)
	if err != nil || string(patch["theme"]) != `"dark"` {
		t.Fatal("appearance export failed", err)
	}
	if _, err = ImportAppearance([]byte(`{"schema":"dant-appearance","version":1,"appearance":{"unknown":"field"}}`)); err == nil {
		t.Fatal("appearance import accepted unknown fields")
	}
}

func nativeUsage(thread, turn string, total, last [5]int64) json.RawMessage {
	counts := func(value [5]int64) map[string]int64 {
		return map[string]int64{"inputTokens": value[0], "cachedInputTokens": value[1], "outputTokens": value[2], "reasoningOutputTokens": value[3], "totalTokens": value[4]}
	}
	raw, _ := json.Marshal(map[string]any{"threadId": thread, "turnId": turn, "tokenUsage": map[string]any{"total": counts(total), "last": counts(last)}})
	return raw
}

func TestUsageCumulativeReceiptsAPIReceiptsAndRestartNeverDoubleCount(t *testing.T) {
	ctx := context.Background()
	now := int64(1760000000000)
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	usage, err := NewTokenUsageStore(persistence, UsageOptions{Now: func() time.Time { return time.UnixMilli(now) }})
	if err != nil {
		t.Fatal(err)
	}
	initial := nativeUsage("thread-a", "turn-a", [5]int64{100, 20, 30, 10, 130}, [5]int64{10, 2, 5, 1, 15})
	changed, err := usage.ObserveCodex(ctx, "runtime-a", initial)
	if err != nil || !changed {
		t.Fatal(err)
	}
	changed, err = usage.ObserveCodex(ctx, "runtime-a", initial)
	if err != nil || changed {
		t.Fatal("duplicate cumulative totals added", err)
	}
	snapshot := usage.Snapshot()
	if snapshot.Subscription.Totals == nil || *snapshot.Subscription.Totals.TotalTokens != 130 || len(snapshot.Activity.Days) != 1 || *snapshot.Activity.Days[0].Subscription.TotalTokens != 15 || *snapshot.Activity.Unallocated.Subscription.TotalTokens != 115 {
		t.Fatal("first native historical allocation was invented")
	}
	now += 1000
	updated := nativeUsage("thread-a", "turn-b", [5]int64{110, 22, 35, 11, 145}, [5]int64{10, 2, 5, 1, 15})
	if changed, err = usage.ObserveCodex(ctx, "runtime-a", updated); err != nil || !changed {
		t.Fatal(err)
	}
	if changed, err = usage.ObserveCodex(ctx, "runtime-a", initial); err != nil || changed {
		t.Fatal("counter reset interpreted as consumption", err)
	}
	api := json.RawMessage(`{"callId":"call-a","responseId":"response-a","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}`)
	if changed, err = usage.ObserveAPIVoice(ctx, api); err != nil || !changed {
		t.Fatal(err)
	}
	restarted, err := NewTokenUsageStore(persistence, UsageOptions{Now: func() time.Time { return time.UnixMilli(now) }})
	if err != nil {
		t.Fatal(err)
	}
	if changed, err = restarted.ObserveAPIVoice(ctx, api); err != nil || changed {
		t.Fatal("API response replayed after restart", err)
	}
	snapshot = restarted.Snapshot()
	if *snapshot.Subscription.Totals.TotalTokens != 145 || *snapshot.APIVoice.Totals.TotalTokens != 10 || snapshot.APIVoice.Totals.CachedInputTokens != nil {
		t.Fatal("usage nullable fields changed")
	}
	raw, _ := json.Marshal(persistence.Snapshot().TokenUsage)
	if strings.Contains(string(raw), "thread-a") || strings.Contains(string(raw), "call-a") || strings.Contains(string(raw), "response-a") {
		t.Fatal("raw source identities persisted")
	}
}

func TestUsageRetainsDailyTotalsBeyondRetentionAndIgnoresMalformedEvents(t *testing.T) {
	ctx := context.Background()
	now := int64(1760000000000)
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	usage, _ := NewTokenUsageStore(persistence, UsageOptions{Now: func() time.Time { return time.UnixMilli(now) }})
	for _, raw := range []string{`null`, `{"threadId":"a","turnId":"b","tokenUsage":{"total":{"totalTokens":1}}}`, `{"threadId":"a","turnId":"b","tokenUsage":{"total":null,"last":null}}`} {
		changed, err := usage.ObserveCodex(ctx, "runtime", json.RawMessage(raw))
		if err != nil || changed {
			t.Fatal("invalid event mutated accounting", err)
		}
	}
	first := json.RawMessage(`{"callId":"a","responseId":"one","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}`)
	if _, err = usage.ObserveAPIVoice(ctx, first); err != nil {
		t.Fatal(err)
	}
	now += 401 * 86400000
	second := json.RawMessage(`{"callId":"a","responseId":"two","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}`)
	if _, err = usage.ObserveAPIVoice(ctx, second); err != nil {
		t.Fatal(err)
	}
	snapshot := usage.Snapshot()
	if len(snapshot.Activity.Days) != 1 || *snapshot.Activity.Unallocated.APIVoice.TotalTokens != 5 || *snapshot.APIVoice.Totals.TotalTokens != 11 {
		t.Fatal("retention lost historical usage")
	}
}

func TestUsageFailedPersistenceDoesNotChangeHighWaterMark(t *testing.T) {
	ctx := context.Background()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	usage, _ := NewTokenUsageStore(persistence, UsageOptions{})
	persistence.Close()
	changed, err := usage.ObserveCodex(ctx, "runtime", nativeUsage("thread", "turn", [5]int64{1, 0, 1, 0, 2}, [5]int64{1, 0, 1, 0, 2}))
	if err == nil || changed || usage.Snapshot().Subscription.Available {
		t.Fatal("failed persistence advanced accounting receipt")
	}
}

func TestSameMillisecondUsageReceiptsKeepInsertionOrderAcrossRestart(t *testing.T) {
	ctx := context.Background()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	options := UsageOptions{Now: func() time.Time { return time.UnixMilli(1760000000000) }}
	usage, err := NewTokenUsageStore(persistence, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		Thread string
		Count  int64
	}{{"later-sort-hash", 11}, {"earlier-sort-hash", 22}} {
		total := [5]int64{test.Count, 0, 1, 0, test.Count + 1}
		if changed, err := usage.ObserveCodex(ctx, "runtime", nativeUsage(test.Thread, "turn", total, total)); err != nil || !changed {
			t.Fatal(err)
		}
	}
	for _, value := range []string{`{"callId":"call","responseId":"a","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}`, `{"callId":"call","responseId":"b","usage":{"input_tokens":11,"output_tokens":3,"total_tokens":14}}`} {
		if _, err = usage.ObserveAPIVoice(ctx, json.RawMessage(value)); err != nil {
			t.Fatal(err)
		}
	}
	for _, current := range []*TokenUsageStore{usage, func() *TokenUsageStore {
		value, err := NewTokenUsageStore(persistence, options)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}()} {
		snapshot := current.Snapshot()
		if *snapshot.Subscription.LastResponse.Counts.TotalTokens != 23 || *snapshot.APIVoice.LastResponse.Counts.TotalTokens != 14 {
			t.Fatal("same-time last response changed on restore")
		}
	}
}

func TestFontInventoryUsesBoundedFixedCommandAndFiltersUnsafeNames(t *testing.T) {
	calls := 0
	result, err := ListSystemFonts(context.Background(), FontOptions{Platform: "windows", Run: func(ctx context.Context, args []string) ([]byte, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok || len(args) != 5 || args[4] != fontScript {
			t.Fatal("unbounded or arbitrary font command")
		}
		return []byte(`["Segoe UI","  Segoe UI  ","Noto Sans","unsafe;CSS",null,9,""]`), nil
	}})
	if err != nil || calls != 1 || result.Source != "windows" || strings.Join(result.Fonts, "|") != "Noto Sans|Segoe UI" {
		t.Fatal("font inventory validation changed", err)
	}
	if _, err = ListSystemFonts(context.Background(), FontOptions{Platform: "windows", Run: func(context.Context, []string) ([]byte, error) { return []byte(`null`), nil }}); !errors.Is(err, ErrFontsUnavailable) {
		t.Fatal("invalid inventory accepted")
	}
	if result, err = ListSystemFonts(context.Background(), FontOptions{Platform: "linux", Run: func(context.Context, []string) ([]byte, error) {
		t.Fatal("non-Windows inventory executed")
		return nil, nil
	}}); err != nil || result.Source != "fallback" {
		t.Fatal("non-Windows fallback changed")
	}
}
