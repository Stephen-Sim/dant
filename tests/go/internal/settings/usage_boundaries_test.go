package settings

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestSavedUsageActivityFallsBackToReceiptsWhenAnyConsumedFieldIsInvalid(t *testing.T) {
	at := int64(1760000000000)
	counts := Counts{valuePtr(7), nil, valuePtr(3), nil, valuePtr(10)}
	nativeCounts := Counts{valuePtr(7), valuePtr(0), valuePtr(3), valuePtr(0), valuePtr(10)}
	native := map[string]NativeRecord{usageDigest("runtime", "thread"): {Total: nativeCounts, Last: nativeCounts, At: at}}
	api := map[string]APIRecord{usageDigest("call", "response"): {Counts: counts, At: at}}
	baseline := Activity{TimeZone: "UTC", RecordedSince: &at, Days: map[string]Providers{"2025-10-09": {APIVoice: &counts}}, Unallocated: Providers{Subscription: &nativeCounts}}
	for _, mode := range []string{"zone", "recorded-since", "retained-from", "days", "unallocated", "provider", "calendar-day", "day-object", "day-provider", "empty-day"} {
		t.Run(mode, func(t *testing.T) {
			raw, _ := json.Marshal(baseline)
			fields := object(raw)
			switch mode {
			case "zone":
				fields["timeZone"] = json.RawMessage(`"invalid/zone"`)
			case "recorded-since":
				fields["recordedSince"] = json.RawMessage(`false`)
			case "retained-from":
				fields["retainedFrom"] = json.RawMessage(`"2025-02-30"`)
			case "days":
				fields["days"] = json.RawMessage(`null`)
			case "unallocated":
				fields["unallocated"] = json.RawMessage(`false`)
			case "provider":
				fields["unallocated"] = json.RawMessage(`{"subscription":false,"apiVoice":null}`)
			case "calendar-day":
				fields["days"] = json.RawMessage(`{"2025-02-30":{"subscription":null,"apiVoice":null}}`)
			case "day-object":
				fields["days"] = json.RawMessage(`{"2025-10-09":false}`)
			case "day-provider":
				fields["days"] = json.RawMessage(`{"2025-10-09":{"subscription":false,"apiVoice":null}}`)
			case "empty-day":
				fields["days"] = json.RawMessage(`{"2025-10-09":{"subscription":null,"apiVoice":null}}`)
			}
			raw, _ = json.Marshal(fields)
			activity := restoreActivity(raw, "UTC", &at, native, api)
			if activity.Unallocated.Subscription == nil || *activity.Unallocated.Subscription.TotalTokens != 10 || len(activity.Days) != 1 {
				t.Fatal("invalid activity lost retained receipts or invented calendar consumption")
			}
			for _, day := range activity.Days {
				if day.APIVoice == nil || *day.APIVoice.TotalTokens != 10 {
					t.Fatal("fallback did not allocate the exact API receipt")
				}
			}
		})
	}
	raw, _ := json.Marshal(baseline)
	if activity := restoreActivity(raw, "UTC", nil, native, api); activity.RetainedFrom != nil || activity.Unallocated.Subscription == nil {
		t.Fatal("restoring without a clock invented a retention boundary")
	}
	if activity := restoreActivity(json.RawMessage(`{}`), "UTC", nil, native, api); len(activity.Days) != 1 || activity.Unallocated.Subscription == nil {
		t.Fatal("legacy activity reconstruction without a clock lost receipts")
	}
}

func TestUsageNumericalUncertaintyAndRetentionNeverBecomeZeroOrWraparound(t *testing.T) {
	for _, raw := range []string{`false`, `-1`, `1.5`, `9007199254740992`, `{}`} {
		if _, valid := decodeNumber(json.RawMessage(raw)); valid {
			t.Fatal("invalid token quantity accepted")
		}
	}
	for _, raw := range []string{
		`{"inputTokens":7,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0}`,
		`{"inputTokens":7,"cachedInputTokens":8,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":10}`,
		`{"inputTokens":7,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":4,"totalTokens":10}`,
		`{"inputTokens":7,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":11}`,
	} {
		if _, valid := decodeCounts(json.RawMessage(raw), false, false); valid {
			t.Fatal("inconsistent token accounting was accepted")
		}
	}
	left := Counts{InputTokens: valuePtr(maxSafe), TotalTokens: valuePtr(maxSafe)}
	right := Counts{InputTokens: valuePtr(1), TotalTokens: valuePtr(1)}
	if sum := addCounts(&left, &right); sum.InputTokens != nil || sum.TotalTokens != nil {
		t.Fatal("overflowed aggregate became a precise token count")
	}
	if clone := addCounts(&left, nil); clone.InputTokens == left.InputTokens || *clone.InputTokens != maxSafe {
		t.Fatal("aggregate clone shared mutable counters")
	}
	prior := Counts{valuePtr(10), valuePtr(5), valuePtr(10), valuePtr(5), valuePtr(20)}
	total := Counts{valuePtr(11), valuePtr(7), valuePtr(11), valuePtr(7), valuePtr(22)}
	if difference := countsDifference(total, prior); difference.CachedInputTokens != nil || difference.ReasoningOutputTokens != nil || *difference.TotalTokens != 2 {
		t.Fatal("inconsistent deltas were reported as confirmed cache or reasoning consumption")
	}
	for _, test := range []struct {
		at   int64
		zone string
	}{{0, "UTC"}, {1760000000000, "invalid/zone"}, {maxDate, "UTC"}} {
		if dayAt(test.at, test.zone) != "" {
			t.Fatal("unrepresentable calendar day was invented")
		}
	}
	activity := Activity{TimeZone: "invalid/zone", Days: map[string]Providers{}}
	if result := trimActivity(activity, 0); len(result.Days) != 0 || result.RetainedFrom != nil {
		t.Fatal("missing calendar boundary invented retention")
	}
	activity.Days["unparseable"] = Providers{}
	if result := trimActivity(activity, 0); result.RetainedFrom != nil {
		t.Fatal("invalid retained day invented a cutoff")
	}
	activity = Activity{TimeZone: "UTC", Days: nil}
	value := Counts{TotalTokens: valuePtr(3)}
	if allocated := allocate(activity, "apiVoice", &value, 1760000000000, false); len(allocated.Days) != 1 {
		t.Fatal("new activity could not allocate its first known receipt")
	}
	if allocated := allocate(activity, "apiVoice", nil, 0, false); !reflect.DeepEqual(allocated, activity) {
		t.Fatal("an absent observation created consumption")
	}
	if allocated := allocate(activity, "apiVoice", &value, 0, false); allocated.Unallocated.APIVoice == nil || *allocated.Unallocated.APIVoice.TotalTokens != 3 {
		t.Fatal("unknown date lost known unallocated consumption")
	}
}

func TestUsageObservationsValidateIdentitiesClockAndInconsistentHistoricalCounters(t *testing.T) {
	if _, err := NewTokenUsageStore(nil, UsageOptions{}); !errors.Is(err, ErrInvalidUsage) {
		t.Fatal("missing usage persistence was accepted")
	}
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	at, notices := int64(0), 0
	usage, err := NewTokenUsageStore(persistence, UsageOptions{Now: func() time.Time { return time.UnixMilli(at) }, Changed: func() { notices++ }})
	if err != nil {
		t.Fatal(err)
	}
	native := nativeUsage("thread", "turn", [5]int64{7, 0, 3, 0, 10}, [5]int64{8, 0, 4, 0, 12})
	api := json.RawMessage(`{"callId":"call","responseId":"response","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}`)
	for _, run := range []func() (bool, error){
		func() (bool, error) { return usage.ObserveCodex(t.Context(), "runtime", native) },
		func() (bool, error) { return usage.ObserveAPIVoice(t.Context(), api) },
		func() (bool, error) { return usage.ObserveAPIVoice(t.Context(), json.RawMessage(`{}`)) },
		func() (bool, error) {
			return usage.ObserveAPIVoice(t.Context(), json.RawMessage(`{"callId":"a","responseId":"b","usage":{"input_tokens":7}}`))
		},
	} {
		if changed, err := run(); err != nil || changed || notices != 0 {
			t.Fatal("invalid clock or accounting input changed usage", err)
		}
	}
	at = 1760000000000
	if changed, err := usage.ObserveCodex(t.Context(), "runtime", native); err != nil || !changed || notices != 1 {
		t.Fatal("valid known total was lost", err)
	}
	state := usage.State()
	if len(state.Activity.Days) != 0 || *state.Activity.Unallocated.Subscription.TotalTokens != 10 {
		t.Fatal("unreliable historical remainder was attributed to a known calendar day")
	}
	for _, invalid := range []string{"", strings.Repeat("😀", 129), "contains\x7f"} {
		if observationID(invalid) {
			t.Fatal("invalid accounting identity accepted")
		}
	}
	if _, valid := nullableDate(json.RawMessage(`null`)); !valid {
		t.Fatal("explicit unknown date was rejected")
	}
}
