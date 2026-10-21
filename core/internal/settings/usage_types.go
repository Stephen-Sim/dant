package settings

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

const maxSafe int64 = 9007199254740991
const maxDate int64 = 8640000000000000
const retentionDays = 400
const maxUsageJSONBytes = 128 * 1024 * 1024

var ErrInvalidUsage = errors.New("token_usage_invalid")

type Counts struct {
	InputTokens           *int64 `json:"inputTokens"`
	CachedInputTokens     *int64 `json:"cachedInputTokens"`
	OutputTokens          *int64 `json:"outputTokens"`
	ReasoningOutputTokens *int64 `json:"reasoningOutputTokens"`
	TotalTokens           *int64 `json:"totalTokens"`
}

func (c Counts) values() [5]*int64 {
	return [5]*int64{c.InputTokens, c.CachedInputTokens, c.OutputTokens, c.ReasoningOutputTokens, c.TotalTokens}
}

func makeCounts(values [5]*int64) Counts {
	return Counts{values[0], values[1], values[2], values[3], values[4]}
}

func valuePtr(value int64) *int64 { return &value }

var countNames = [5]string{"inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"}

func decodeNumber(raw json.RawMessage) (*int64, bool) {
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, true
	}
	var number float64
	if json.Unmarshal(raw, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) || number < 0 || number > float64(maxSafe) {
		return nil, false
	}
	value := int64(number)
	return &value, true
}

func decodeCounts(raw json.RawMessage, optional, aggregate bool) (*Counts, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, false
	}
	values := [5]*int64{}
	for index, key := range countNames {
		field, exists := fields[key]
		if !exists {
			return nil, false
		}
		value, ok := decodeNumber(field)
		if !ok || value == nil && !aggregate && !(optional && (index == 1 || index == 3)) {
			return nil, false
		}
		values[index] = value
	}
	if values[0] != nil && values[1] != nil && *values[1] > *values[0] || values[2] != nil && values[3] != nil && *values[3] > *values[2] || values[0] != nil && values[2] != nil && values[4] != nil && (*values[0] > maxSafe-*values[2] || *values[4] != *values[0]+*values[2]) {
		return nil, false
	}
	result := makeCounts(values)
	return &result, true
}

type NativeRecord struct {
	Total Counts `json:"total"`
	Last  Counts `json:"last"`
	At    int64  `json:"at"`
}

type APIRecord struct {
	Counts Counts `json:"counts"`
	At     int64  `json:"at"`
}

type Providers struct {
	Subscription *Counts `json:"subscription"`
	APIVoice     *Counts `json:"apiVoice"`
}

type Activity struct {
	TimeZone      string               `json:"timeZone"`
	RecordedSince *int64               `json:"recordedSince"`
	RetainedFrom  *string              `json:"retainedFrom"`
	Days          map[string]Providers `json:"days"`
	Unallocated   Providers            `json:"unallocated"`
}

type TokenState struct {
	Version       int                     `json:"version"`
	RecordedSince *int64                  `json:"recordedSince"`
	Native        map[string]NativeRecord `json:"native"`
	APIVoice      map[string]APIRecord    `json:"apiVoice"`
	Activity      Activity                `json:"activity"`
	nativeOrder   []string
	apiOrder      []string
}

func validTimestamp(value int64) bool { return value > 0 && value <= maxDate }
func zone(value string) string {
	if canonical, ok := i18n.CanonicalTimeZone(value); ok {
		return canonical
	}
	return "UTC"
}

func dayAt(at int64, timeZone string) string {
	if !validTimestamp(at) {
		return ""
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return ""
	}
	value := time.UnixMilli(at).In(location)
	if value.Year() < 0 || value.Year() > 9999 {
		return ""
	}
	return value.Format("2006-01-02")
}

func calendarDate(value string) bool {
	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func emptyActivity(timeZone string) Activity {
	return Activity{TimeZone: zone(timeZone), Days: map[string]Providers{}}
}

func cloneCounts(value *Counts) *Counts {
	if value == nil {
		return nil
	}
	values := value.values()
	for index, item := range values {
		if item != nil {
			values[index] = valuePtr(*item)
		}
	}
	result := makeCounts(values)
	return &result
}

func addCounts(left, right *Counts) *Counts {
	if left == nil {
		return cloneCounts(right)
	}
	if right == nil {
		return cloneCounts(left)
	}
	a, b := left.values(), right.values()
	result := [5]*int64{}
	for index := range a {
		if a[index] != nil && b[index] != nil && *a[index] <= maxSafe-*b[index] {
			result[index] = valuePtr(*a[index] + *b[index])
		}
	}
	value := makeCounts(result)
	return &value
}

func getProvider(value Providers, provider string) *Counts {
	if provider == "subscription" {
		return value.Subscription
	}
	return value.APIVoice
}

func setProvider(value *Providers, provider string, counts *Counts) {
	if provider == "subscription" {
		value.Subscription = counts
	} else {
		value.APIVoice = counts
	}
}

func trimActivity(activity Activity, at int64) Activity {
	today := dayAt(at, activity.TimeZone)
	for day := range activity.Days {
		if day > today {
			today = day
		}
	}
	if today == "" {
		return activity
	}
	parsed, err := time.Parse("2006-01-02", today)
	if err != nil {
		return activity
	}
	cutoff := parsed.AddDate(0, 0, -(retentionDays - 1)).Format("2006-01-02")
	if activity.RetainedFrom != nil && *activity.RetainedFrom > cutoff {
		cutoff = *activity.RetainedFrom
	}
	activity.RetainedFrom = &cutoff
	days := map[string]Providers{}
	for date, value := range activity.Days {
		if date >= cutoff {
			days[date] = value
		} else {
			for _, provider := range []string{"subscription", "apiVoice"} {
				setProvider(&activity.Unallocated, provider, addCounts(getProvider(activity.Unallocated, provider), getProvider(value, provider)))
			}
		}
	}
	activity.Days = days
	return activity
}

func allocate(activity Activity, provider string, value *Counts, at int64, trim bool) Activity {
	if value == nil {
		return activity
	}
	if trim {
		activity = trimActivity(activity, at)
	}
	date := dayAt(at, activity.TimeZone)
	if date != "" && (activity.RecordedSince == nil || at < *activity.RecordedSince) {
		activity.RecordedSince = valuePtr(at)
	}
	if date == "" || activity.RetainedFrom != nil && date < *activity.RetainedFrom {
		setProvider(&activity.Unallocated, provider, addCounts(getProvider(activity.Unallocated, provider), value))
		return activity
	}
	if activity.Days == nil {
		activity.Days = map[string]Providers{}
	}
	entry := activity.Days[date]
	setProvider(&entry, provider, addCounts(getProvider(entry, provider), value))
	activity.Days[date] = entry
	return activity
}
