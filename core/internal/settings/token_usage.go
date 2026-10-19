package settings

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type UsagePersistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
}

type UsageOptions struct {
	Now     func() time.Time
	Changed func()
}

type TokenUsageStore struct {
	mu      sync.Mutex
	store   UsagePersistence
	state   TokenState
	options UsageOptions
}

var usageKey = regexp.MustCompile(`^[a-f0-9]{64}$`)

func object(raw json.RawMessage) contracts.RawObject {
	value, err := contracts.DecodeObject(raw, maxUsageJSONBytes)
	if err != nil {
		return nil
	}
	return value
}

func dateNumber(raw json.RawMessage) (int64, bool) {
	value, ok := decodeNumber(raw)
	if !ok || value == nil || !validTimestamp(*value) {
		return 0, false
	}
	return *value, true
}

func nullableDate(raw json.RawMessage) (*int64, bool) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true
	}
	value, ok := dateNumber(raw)
	if !ok {
		return nil, false
	}
	return &value, true
}

func providerValue(raw json.RawMessage) (*Counts, bool) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true
	}
	return decodeCounts(raw, true, true)
}

func restoreActivity(raw json.RawMessage, timeZone string, at *int64, native map[string]NativeRecord, api map[string]APIRecord) Activity {
	saved := object(raw)
	valid := saved != nil
	var activity Activity
	if valid {
		if json.Unmarshal(saved["timeZone"], &activity.TimeZone) != nil || zone(activity.TimeZone) != activity.TimeZone {
			valid = false
		}
		var ok bool
		activity.RecordedSince, ok = nullableDate(saved["recordedSince"])
		if !ok {
			valid = false
		}
		if string(bytes.TrimSpace(saved["retainedFrom"])) != "null" {
			var retained string
			if json.Unmarshal(saved["retainedFrom"], &retained) != nil || !calendarDate(retained) {
				valid = false
			} else {
				activity.RetainedFrom = &retained
			}
		}
		days, unallocated := object(saved["days"]), object(saved["unallocated"])
		if days == nil || unallocated == nil {
			valid = false
		}
		activity.Days = map[string]Providers{}
		for _, provider := range []string{"subscription", "apiVoice"} {
			value, ok := providerValue(unallocated[provider])
			if !ok {
				valid = false
			}
			setProvider(&activity.Unallocated, provider, value)
		}
		for date, raw := range days {
			entry := object(raw)
			if !calendarDate(date) || entry == nil {
				valid = false
				break
			}
			providers := Providers{}
			for _, provider := range []string{"subscription", "apiVoice"} {
				value, ok := providerValue(entry[provider])
				if !ok {
					valid = false
				}
				setProvider(&providers, provider, value)
			}
			if providers.Subscription == nil && providers.APIVoice == nil {
				valid = false
			}
			activity.Days[date] = providers
		}
	}
	if !valid {
		activity = emptyActivity(timeZone)
		for _, record := range native {
			activity.Unallocated.Subscription = addCounts(activity.Unallocated.Subscription, &record.Total)
		}
		if at != nil {
			activity = trimActivity(activity, *at)
		}
		for _, record := range api {
			activity = allocate(activity, "apiVoice", &record.Counts, record.At, at != nil)
		}
	}
	if at != nil {
		return trimActivity(activity, *at)
	}
	return activity
}

func RestoreTokenUsage(raw json.RawMessage, timeZone string, at *int64) TokenState {
	result := TokenState{Version: 2, Native: map[string]NativeRecord{}, APIVoice: map[string]APIRecord{}, Activity: emptyActivity(timeZone)}
	saved := object(raw)
	var version int
	if saved == nil || json.Unmarshal(saved["version"], &version) != nil || version != 1 && version != 2 {
		if at != nil {
			result.Activity = trimActivity(result.Activity, *at)
		}
		return result
	}
	if recorded, ok := dateNumber(saved["recordedSince"]); ok {
		result.RecordedSince = &recorded
	}
	result.nativeOrder = orderedKeys(saved["native"])
	result.apiOrder = orderedKeys(saved["apiVoice"])
	for key, raw := range object(saved["native"]) {
		entry := object(raw)
		total, totalOK := decodeCounts(entry["total"], false, false)
		last, lastOK := decodeCounts(entry["last"], false, false)
		timestamp, timeOK := dateNumber(entry["at"])
		if usageKey.MatchString(key) && totalOK && lastOK && timeOK {
			result.Native[key] = NativeRecord{*total, *last, timestamp}
		}
	}
	for key, raw := range object(saved["apiVoice"]) {
		entry := object(raw)
		counts, ok := decodeCounts(entry["counts"], true, false)
		timestamp, timeOK := dateNumber(entry["at"])
		if usageKey.MatchString(key) && ok && timeOK {
			result.APIVoice[key] = APIRecord{*counts, timestamp}
		}
	}
	var activity json.RawMessage
	if version == 2 {
		activity = saved["activity"]
	}
	result.Activity = restoreActivity(activity, timeZone, at, result.Native, result.APIVoice)
	return result
}

func NewTokenUsageStore(store UsagePersistence, options UsageOptions) (*TokenUsageStore, error) {
	if store == nil {
		return nil, ErrInvalidUsage
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	state := store.Snapshot()
	raw, _ := json.Marshal(state.TokenUsage)
	now := options.Now().UnixMilli()
	return &TokenUsageStore{store: store, options: options, state: RestoreTokenUsage(raw, state.Settings.TimeZone, &now)}, nil
}

func cloneUsage(value TokenState) TokenState {
	raw, _ := json.Marshal(value)
	var result TokenState
	_ = json.Unmarshal(raw, &result)
	result.nativeOrder = append([]string{}, value.nativeOrder...)
	result.apiOrder = append([]string{}, value.apiOrder...)
	return result
}

func (s *TokenUsageStore) apply(ctx context.Context, operation func(*TokenState) bool) (bool, error) {
	s.mu.Lock()
	next := cloneUsage(s.state)
	if !operation(&next) {
		s.mu.Unlock()
		return false, nil
	}
	raw, err := json.Marshal(next)
	if err == nil {
		var fields contracts.RawObject
		fields, err = contracts.DecodeObject(raw, maxUsageJSONBytes)
		if err == nil {
			err = s.store.Mutate(ctx, func(state *contracts.State) error { state.TokenUsage = fields; return nil })
		}
	}
	if err == nil {
		s.state = next
	}
	s.mu.Unlock()
	if err != nil {
		return false, err
	}
	if s.options.Changed != nil {
		s.options.Changed()
	}
	return true, nil
}

func observationID(value string) bool {
	if value == "" || len(utf16.Encode([]rune(value))) > 256 {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func usageDigest(values ...string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(values)
	raw := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	raw = bytes.ReplaceAll(raw, []byte(`\u2028`), []byte("\u2028"))
	raw = bytes.ReplaceAll(raw, []byte(`\u2029`), []byte("\u2029"))
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func rawText(raw json.RawMessage) string {
	var result string
	_ = json.Unmarshal(raw, &result)
	return result
}

func countsDifference(total, prior Counts) Counts {
	a, b := total.values(), prior.values()
	values := [5]*int64{}
	for index := range a {
		if a[index] != nil && b[index] != nil {
			values[index] = valuePtr(*a[index] - *b[index])
		}
	}
	values[4] = valuePtr(*values[0] + *values[2])
	if values[1] != nil && (*values[1] < 0 || *values[1] > *values[0]) {
		values[1] = nil
	}
	if values[3] != nil && (*values[3] < 0 || *values[3] > *values[2]) {
		values[3] = nil
	}
	return makeCounts(values)
}

func (s *TokenUsageStore) ObserveCodex(ctx context.Context, runtimeID string, params json.RawMessage) (bool, error) {
	input := object(params)
	threadID, turnID := rawText(input["threadId"]), rawText(input["turnId"])
	if !observationID(runtimeID) || !observationID(threadID) || !observationID(turnID) {
		return false, nil
	}
	usage := object(input["tokenUsage"])
	total, totalOK := decodeCounts(usage["total"], false, false)
	last, lastOK := decodeCounts(usage["last"], false, false)
	if !totalOK || !lastOK {
		return false, nil
	}
	key := usageDigest(runtimeID, threadID)
	return s.apply(ctx, func(state *TokenState) bool {
		prior, exists := state.Native[key]
		if exists {
			equal := true
			a, b := total.values(), prior.Total.values()
			for index := range a {
				if *a[index] < *b[index] {
					return false
				}
				if *a[index] != *b[index] {
					equal = false
				}
			}
			if equal {
				return false
			}
		}
		at := s.options.Now().UnixMilli()
		if !validTimestamp(at) {
			return false
		}
		activity := trimActivity(state.Activity, at)
		if exists {
			difference := countsDifference(*total, prior.Total)
			activity = allocate(activity, "subscription", &difference, at, true)
		} else {
			a, b := total.values(), last.values()
			remainder := [5]*int64{}
			valid := true
			for index := range a {
				difference := *a[index] - *b[index]
				if difference < 0 {
					valid = false
				}
				remainder[index] = valuePtr(difference)
			}
			reliable := makeCounts(remainder)
			if valid {
				encoded, _ := json.Marshal(reliable)
				_, valid = decodeCounts(encoded, false, false)
			}
			historical := total
			if valid {
				historical = &reliable
			}
			activity.Unallocated.Subscription = addCounts(activity.Unallocated.Subscription, historical)
			if valid {
				activity = allocate(activity, "subscription", last, at, true)
			}
		}
		state.Activity = activity
		if state.RecordedSince == nil {
			state.RecordedSince = valuePtr(at)
		}
		state.Native[key] = NativeRecord{*total, *last, at}
		if !exists {
			state.nativeOrder = append(state.nativeOrder, key)
		}
		return true
	})
}

func (s *TokenUsageStore) ObserveAPIVoice(ctx context.Context, params json.RawMessage) (bool, error) {
	input := object(params)
	call, response := rawText(input["callId"]), rawText(input["responseId"])
	usage := object(input["usage"])
	if !observationID(call) || !observationID(response) || usage == nil {
		return false, nil
	}
	details := object(usage["input_token_details"])
	cached := details["cached_tokens"]
	if len(cached) == 0 {
		cached = json.RawMessage("null")
	}
	encoded, _ := json.Marshal(contracts.RawObject{"inputTokens": usage["input_tokens"], "cachedInputTokens": cached, "outputTokens": usage["output_tokens"], "reasoningOutputTokens": json.RawMessage("null"), "totalTokens": usage["total_tokens"]})
	counts, ok := decodeCounts(encoded, true, false)
	if !ok {
		return false, nil
	}
	key := usageDigest(call, response)
	return s.apply(ctx, func(state *TokenState) bool {
		if _, exists := state.APIVoice[key]; exists {
			return false
		}
		at := s.options.Now().UnixMilli()
		if !validTimestamp(at) {
			return false
		}
		state.Activity = allocate(state.Activity, "apiVoice", counts, at, true)
		if state.RecordedSince == nil {
			state.RecordedSince = valuePtr(at)
		}
		state.APIVoice[key] = APIRecord{*counts, at}
		state.apiOrder = append(state.apiOrder, key)
		return true
	})
}

type LastCounts struct {
	Counts
	At int64 `json:"at"`
}

type ProviderSnapshot struct {
	Available    bool        `json:"available"`
	Totals       *Counts     `json:"totals"`
	LastResponse *LastCounts `json:"lastResponse"`
}

type ActivityDay struct {
	Date         string  `json:"date"`
	Subscription *Counts `json:"subscription"`
	APIVoice     *Counts `json:"apiVoice"`
}

type ActivitySnapshot struct {
	TimeZone      string        `json:"timeZone"`
	RecordedSince *int64        `json:"recordedSince"`
	RetainedFrom  *string       `json:"retainedFrom"`
	Days          []ActivityDay `json:"days"`
	Unallocated   Providers     `json:"unallocated"`
}

type UsageSnapshot struct {
	RecordedSince *int64           `json:"recordedSince"`
	Subscription  ProviderSnapshot `json:"subscription"`
	APIVoice      ProviderSnapshot `json:"apiVoice"`
	Activity      ActivitySnapshot `json:"activity"`
}

func (s *TokenUsageStore) Snapshot() UsageSnapshot {
	s.mu.Lock()
	state := cloneUsage(s.state)
	s.mu.Unlock()
	result := UsageSnapshot{RecordedSince: state.RecordedSince}
	for _, key := range recordKeys(state.nativeOrder, state.Native) {
		record := state.Native[key]
		result.Subscription.Available = true
		result.Subscription.Totals = addCounts(result.Subscription.Totals, &record.Total)
		if result.Subscription.LastResponse == nil || record.At >= result.Subscription.LastResponse.At {
			result.Subscription.LastResponse = &LastCounts{record.Last, record.At}
		}
	}
	for _, key := range recordKeys(state.apiOrder, state.APIVoice) {
		record := state.APIVoice[key]
		result.APIVoice.Available = true
		result.APIVoice.Totals = addCounts(result.APIVoice.Totals, &record.Counts)
		if result.APIVoice.LastResponse == nil || record.At >= result.APIVoice.LastResponse.At {
			result.APIVoice.LastResponse = &LastCounts{record.Counts, record.At}
		}
	}
	activity := trimActivity(state.Activity, s.options.Now().UnixMilli())
	result.Activity = ActivitySnapshot{activity.TimeZone, activity.RecordedSince, activity.RetainedFrom, []ActivityDay{}, activity.Unallocated}
	dates := []string{}
	for date := range activity.Days {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	for _, date := range dates {
		entry := activity.Days[date]
		result.Activity.Days = append(result.Activity.Days, ActivityDay{date, entry.Subscription, entry.APIVoice})
	}
	return result
}

func (s *TokenUsageStore) State() TokenState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneUsage(s.state)
}
