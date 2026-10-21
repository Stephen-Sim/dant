package schedules

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

const schedulerPollInterval = time.Second

type Persistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
	MaterializeScheduledMessage(context.Context, *contracts.ChatMessage, bool) (*contracts.ChatMessage, error)
}

type Options struct {
	Now       func() time.Time
	NewID     func() string
	Available func() bool
	ActiveIDs func() []string
	QueuedIDs func() []string
	Enqueue   func(context.Context, *contracts.ChatMessage) error
	Changed   func()
}

type Scheduler struct {
	mu       sync.Mutex
	database *Database
	store    Persistence
	options  Options
	owner    string
	closed   bool
	cancel   context.CancelFunc
	done     chan struct{}
}

func New(ctx context.Context, database *Database, store Persistence, options Options) (*Scheduler, error) {
	if database == nil || store == nil || options.Available == nil || options.Enqueue == nil {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = freshID
	}
	scheduler := &Scheduler{database: database, store: store, options: options, owner: options.NewID()}
	if !validID(scheduler.owner) {
		return nil, ErrInvalid
	}
	if _, err := scheduler.Reconcile(ctx); err != nil {
		return nil, err
	}
	return scheduler, nil
}

func (s *Scheduler) available() bool { return !s.closed && s.options.Available() }
func (s *Scheduler) changed() {
	if s.options.Changed != nil {
		s.options.Changed()
	}
}

func (s *Scheduler) refresh(ctx context.Context) (Snapshot, error) {
	snapshot, err := s.database.Snapshot(ctx)
	if err != nil {
		return snapshot, err
	}
	items := make([]json.RawMessage, 0, len(snapshot.Items))
	for _, item := range snapshot.Items {
		raw, err := json.Marshal(item)
		if err != nil {
			return snapshot, err
		}
		items = append(items, raw)
	}
	current := s.store.Snapshot()
	same := len(current.Schedules) == len(items) && len(current.DeletedScheduleRequestIDs) == len(snapshot.DeletedRequestIDs)
	if same {
		for index := range items {
			if !bytes.Equal(current.Schedules[index], items[index]) {
				same = false
				break
			}
		}
	}
	if same {
		for index := range snapshot.DeletedRequestIDs {
			if current.DeletedScheduleRequestIDs[index] != snapshot.DeletedRequestIDs[index] {
				same = false
				break
			}
		}
	}
	if same {
		return snapshot, nil
	}
	err = s.store.Mutate(ctx, func(state *contracts.State) error {
		state.Schedules = items
		state.DeletedScheduleRequestIDs = append([]string{}, snapshot.DeletedRequestIDs...)
		return nil
	})
	return snapshot, err
}

func (s *Scheduler) Reconcile(ctx context.Context) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reconcile(ctx)
}

func (s *Scheduler) reconcile(ctx context.Context) (int, error) {
	held, err := s.database.RecoverPrepared(ctx, s.owner, true)
	if err != nil {
		return 0, err
	}
	for _, dispatch := range held {
		_, err = s.database.MaterializeHeld(ctx, dispatch.Message.ID, func(current Dispatch) error {
			_, err := s.store.MaterializeScheduledMessage(ctx, current.Message.Chat(), true)
			return err
		})
		if err != nil {
			return 0, err
		}
	}
	_, err = s.refresh(ctx)
	return len(held), err
}

func (s *Scheduler) timeZone() string {
	zone := s.store.Snapshot().Settings.TimeZone
	if location, err := TimeZone(zone); err == nil {
		return location.String()
	}
	return "UTC"
}

type ListResult struct {
	Items    []json.RawMessage `json:"items"`
	Now      string            `json:"now"`
	TimeZone string            `json:"timeZone"`
}

func formatISO(at int64) string {
	value := time.UnixMilli(at).UTC()
	year := value.Year()
	if year >= 0 && year <= 9999 {
		return value.Format("2006-01-02T15:04:05.000Z")
	}
	sign := "+"
	if year < 0 {
		sign = "-"
		year = -year
	}
	return sign + fmtYear(year) + value.Format("-01-02T15:04:05.000Z")
}

func fmtYear(value int) string {
	text := strconv.Itoa(value)
	for len(text) < 6 {
		text = "0" + text
	}
	return text
}

func present(record Record, state contracts.State) (json.RawMessage, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	var fields contracts.RawObject
	if json.Unmarshal(raw, &fields) != nil {
		return nil, ErrInvalid
	}
	delete(fields, "creationFingerprint")
	set := func(key string, value any) { fields[key], _ = json.Marshal(value) }
	cron, ok := record.Cron.Get()
	if ok {
		set("cron", cron)
	} else {
		set("cron", nil)
	}
	set("priority", priority(record))
	zone := recordZone(record)
	location, err := TimeZone(zone)
	if err != nil {
		zone = "UTC"
		location = time.UTC
	}
	zone = location.String()
	set("timeZone", zone)
	set("enabled", record.Status == contracts.ScheduleStatusPending)
	if validInstant(record.At) {
		set("atISO", formatISO(int64(record.At)))
		set("localAt", i18n.ScheduleLocalTime(int64(record.At), location))
	} else {
		set("atISO", nil)
		set("localAt", nil)
	}
	if record.MessageID != nil {
		for _, message := range state.Messages {
			if message != nil && message.ID == *record.MessageID {
				if status, ok := message.Status.Get(); ok {
					set("taskStatus", status)
				}
			}
		}
	}
	return json.Marshal(fields)
}

func (s *Scheduler) List(ctx context.Context) (ListResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := s.refresh(ctx)
	if err != nil {
		return ListResult{}, err
	}
	state := s.store.Snapshot()
	result := ListResult{Items: []json.RawMessage{}, Now: formatISO(s.options.Now().UnixMilli()), TimeZone: s.timeZone()}
	for _, item := range snapshot.Items {
		raw, err := present(item, state)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, raw)
	}
	return result, nil
}

func findRecord(items []Record, id string) (Record, bool) {
	for _, item := range items {
		if item.ID == id {
			return item, true
		}
	}
	return Record{}, false
}

func (s *Scheduler) Get(ctx context.Context, id string) (json.RawMessage, error) {
	if !validID(id) {
		return nil, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := s.refresh(ctx)
	if err != nil {
		return nil, err
	}
	item, ok := findRecord(snapshot.Items, id)
	if !ok {
		return nil, ErrNotFound
	}
	return present(item, s.store.Snapshot())
}

var requestID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func inputInstant(raw json.RawMessage, allowEpoch bool) (int64, error) {
	if allowEpoch {
		var number float64
		if json.Unmarshal(raw, &number) == nil && validInstant(number) {
			return int64(number), nil
		}
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return 0, ErrInvalid
	}
	pattern := regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$`)
	match := pattern.FindStringSubmatch(value)
	if match == nil {
		return 0, ErrInvalid
	}
	if match[8] != "Z" {
		hours, _ := strconv.Atoi(match[8][1:3])
		minutes, _ := strconv.Atoi(match[8][4:6])
		if hours > 23 || minutes > 59 {
			return 0, ErrInvalid
		}
	}
	year, _ := strconv.Atoi(match[1])
	if year < 100 {
		return 0, ErrInvalid
	}
	if match[6] == "" {
		value = match[1] + "-" + match[2] + "-" + match[3] + "T" + match[4] + ":" + match[5] + ":00" + match[8]
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || !validInstant(float64(parsed.UnixMilli())) {
		return 0, ErrInvalid
	}
	return parsed.UnixMilli(), nil
}

func boolInput(object contracts.RawObject, name string, fallback bool) (bool, error) {
	raw, ok := object[name]
	if !ok {
		return fallback, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return false, ErrInvalid
	}
	var result bool
	if json.Unmarshal(raw, &result) != nil {
		return false, ErrInvalid
	}
	return result, nil
}

func textInput(object contracts.RawObject, name string, fallback string) (string, error) {
	raw, ok := object[name]
	if !ok {
		return fallback, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return "", ErrInvalid
	}
	var result string
	if json.Unmarshal(raw, &result) != nil {
		return "", ErrInvalid
	}
	return result, nil
}

func jsJSON(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	raw := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	raw = bytes.ReplaceAll(raw, []byte(`\u2028`), []byte("\u2028"))
	return bytes.ReplaceAll(raw, []byte(`\u2029`), []byte("\u2029"))
}

func hashJSON(value any) string {
	hash := sha256.Sum256(jsJSON(value))
	return hex.EncodeToString(hash[:])
}

// CommitAuthorization fences a local commit after the scheduler has acquired its
// own lock. The callback must not call Scheduler methods or perform external I/O.
type CommitAuthorization func(context.Context, func(context.Context) error) error

func (s *Scheduler) Save(ctx context.Context, raw json.RawMessage, allowEpoch bool) (json.RawMessage, error) {
	return s.save(ctx, raw, allowEpoch, nil)
}

func (s *Scheduler) SaveAuthorized(ctx context.Context, raw json.RawMessage, allowEpoch bool, authorize CommitAuthorization) (json.RawMessage, error) {
	if authorize == nil {
		return nil, ErrInvalid
	}
	return s.save(ctx, raw, allowEpoch, authorize)
}

func (s *Scheduler) save(ctx context.Context, raw json.RawMessage, allowEpoch bool, authorize CommitAuthorization) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input, err := contracts.DecodeObject(raw, MaxRecordBytes)
	if err != nil {
		return nil, ErrInvalid
	}
	allowed := map[string]bool{"id": true, "text": true, "at": true, "cron": true, "priority": true, "timeZone": true, "enabled": true, "clientRequestId": true}
	for key := range input {
		if !allowed[key] {
			return nil, ErrInvalid
		}
	}
	snapshot, err := s.refresh(ctx)
	if err != nil {
		return nil, err
	}
	id, err := textInput(input, "id", "")
	if err != nil {
		return nil, err
	}
	var old *Record
	if _, ok := input["id"]; ok {
		item, exists := findRecord(snapshot.Items, id)
		if !exists {
			return nil, ErrNotFound
		}
		old = &item
	}
	clientRequest, err := textInput(input, "clientRequestId", "")
	if err != nil {
		return nil, err
	}
	if _, exists := input["clientRequestId"]; exists && (!allowEpoch || old != nil || !requestID.MatchString(clientRequest)) {
		return nil, ErrInvalid
	}
	text := ""
	if old != nil {
		text = old.Text
	}
	text, err = textInput(input, "text", text)
	if err != nil || trim(text) == "" || strings.ContainsRune(text, 0) {
		return nil, ErrInvalid
	}
	cron := ""
	if old != nil {
		cron, _ = old.Cron.Get()
	}
	if value, exists := input["cron"]; exists {
		if string(bytes.TrimSpace(value)) == "null" {
			cron = ""
		} else {
			var parsed string
			if json.Unmarshal(value, &parsed) != nil {
				return nil, ErrInvalid
			}
			value, err := ParseCron(parsed)
			if err != nil {
				return nil, err
			}
			cron = value.Expression
		}
	}
	if cron != "" {
		if _, exists := input["at"]; exists {
			return nil, ErrInvalid
		}
	}
	selectedPriority := contracts.TaskPriorityNormal
	if old != nil {
		selectedPriority = priority(*old)
	}
	if value, exists := input["priority"]; exists {
		if json.Unmarshal(value, &selectedPriority) != nil || !selectedPriority.Valid() {
			return nil, ErrInvalid
		}
	}
	zone := "UTC"
	if old != nil {
		zone = recordZone(*old)
	} else if cron != "" {
		zone = s.timeZone()
	} else if !allowEpoch {
		zone = ""
	}
	zone, err = textInput(input, "timeZone", zone)
	if err != nil {
		return nil, err
	}
	location, zoneErr := TimeZone(zone)
	if zoneErr != nil {
		return nil, zoneErr
	}
	zone = location.String()
	enabled := old == nil || old.Status != contracts.ScheduleStatusPaused
	enabled, err = boolInput(input, "enabled", enabled)
	if err != nil {
		return nil, err
	}
	at := float64(0)
	if old != nil {
		at = old.At
	}
	if value, exists := input["at"]; exists {
		parsed, err := inputInstant(value, allowEpoch)
		if err != nil {
			return nil, err
		}
		at = float64(parsed)
	}
	now := float64(s.options.Now().UnixMilli())
	if !validInstant(now) {
		return nil, ErrInvalid
	}
	fingerprintEnabled, err := boolInput(input, "enabled", true)
	if err != nil {
		return nil, err
	}
	fingerprint, legacyFingerprint := "", ""
	if clientRequest != "" {
		if cron != "" {
			fingerprint = hashJSON(struct {
				Text     string                 `json:"text"`
				Cron     string                 `json:"cron"`
				TimeZone string                 `json:"timeZone"`
				Priority contracts.TaskPriority `json:"priority"`
				Enabled  bool                   `json:"enabled"`
			}{text, cron, zone, selectedPriority, fingerprintEnabled})
		} else {
			fingerprint = hashJSON(struct {
				Text     string                 `json:"text"`
				At       float64                `json:"at"`
				Cron     *string                `json:"cron"`
				TimeZone string                 `json:"timeZone"`
				Priority contracts.TaskPriority `json:"priority"`
				Enabled  bool                   `json:"enabled"`
			}{text, at, nil, zone, selectedPriority, fingerprintEnabled})
			if selectedPriority == contracts.TaskPriorityNormal {
				legacyFingerprint = hashJSON(struct {
					Text     string  `json:"text"`
					At       float64 `json:"at"`
					TimeZone string  `json:"timeZone"`
					Enabled  bool    `json:"enabled"`
				}{text, at, zone, fingerprintEnabled})
			}
		}
		for _, deleted := range snapshot.DeletedRequestIDs {
			if deleted == clientRequest {
				return nil, ErrConflict
			}
		}
		for _, record := range snapshot.Items {
			if record.ClientRequestID != nil && *record.ClientRequestID == clientRequest {
				saved, ok := record.CreationFingerprint.Get()
				if !ok || saved != fingerprint && saved != legacyFingerprint {
					return nil, ErrConflict
				}
				return present(record, s.store.Snapshot())
			}
		}
	}
	if old != nil && old.Status == contracts.ScheduleStatusDispatched && cron == "" {
		if _, exists := input["at"]; !exists {
			return nil, ErrConflict
		}
	}
	if cron != "" {
		oldCron := ""
		if old != nil {
			oldCron, _ = old.Cron.Get()
		}
		if old == nil || cron != oldCron || zone != recordZone(*old) || !validInstant(at) || old.Status == contracts.ScheduleStatusDispatched || enabled && old.Status == contracts.ScheduleStatusPaused && at <= now {
			next, err := NextAt(cron, int64(now), zone)
			if err != nil {
				return nil, err
			}
			at = float64(next)
		}
	} else if old != nil {
		if oldCron, ok := old.Cron.Get(); ok && oldCron != "" {
			if _, exists := input["at"]; !exists {
				return nil, ErrInvalid
			}
		}
	}
	if !validInstant(at) {
		return nil, ErrInvalid
	}
	_, atSupplied := input["at"]
	if (old == nil || atSupplied || enabled && old.Status != contracts.ScheduleStatusPending) && at <= now {
		return nil, ErrInvalid
	}
	item := Record{}
	if old != nil {
		item = *old
	} else {
		item.ID = s.options.NewID()
		item.CreatedAt = &now
	}
	if !validID(item.ID) {
		return nil, ErrInvalid
	}
	item.Text = text
	item.At = at
	item.Cron = contracts.Null[string]()
	if cron != "" {
		item.Cron = contracts.Some(cron)
	}
	item.Priority = contracts.Some(selectedPriority)
	item.TimeZone = &zone
	item.Enabled = &enabled
	item.Status = contracts.ScheduleStatusPaused
	if enabled {
		item.Status = contracts.ScheduleStatusPending
	}
	item.UpdatedAt = &now
	if clientRequest != "" {
		item.ClientRequestID = &clientRequest
		item.CreationFingerprint = contracts.Some(fingerprint)
	}
	if old != nil && old.Status == contracts.ScheduleStatusDispatched {
		item.RunHistory = runHistory(*old, nil)
		item.MessageID = nil
		item.DispatchedAt = nil
	}
	items := append([]Record{}, snapshot.Items...)
	if old == nil {
		items = append(items, item)
	} else {
		for index := range items {
			if items[index].ID == item.ID {
				items[index] = item
			}
		}
	}
	active := map[string]bool{}
	if s.options.ActiveIDs != nil {
		for _, id := range s.options.ActiveIDs() {
			active[id] = true
		}
	}
	var before func() error
	if old != nil {
		if _, exists := input["priority"]; exists {
			before = func() error {
				return s.store.Mutate(ctx, func(state *contracts.State) error {
					for _, message := range state.Messages {
						if message != nil && message.Scheduled && message.ScheduleID == item.ID && !active[message.ID] {
							if status, ok := message.Status.Get(); ok && status == contracts.MessageStatus(contracts.TaskStatusQueued) {
								message.ProgressPriority = contracts.Some(selectedPriority)
							}
						}
					}
					return nil
				})
			}
		}
	}
	commit := func(commitContext context.Context) error {
		return s.database.Replace(commitContext, snapshot.Revision, items, snapshot.DeletedRequestIDs, before)
	}
	if authorize != nil {
		err = authorize(ctx, commit)
	} else {
		err = commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	if _, err = s.refresh(ctx); err != nil {
		return nil, err
	}
	s.changed()
	return present(item, s.store.Snapshot())
}

func (s *Scheduler) Remove(ctx context.Context, id string) (json.RawMessage, error) {
	return s.remove(ctx, id, nil)
}

func (s *Scheduler) RemoveAuthorized(ctx context.Context, id string, authorize CommitAuthorization) (json.RawMessage, error) {
	if authorize == nil {
		return nil, ErrInvalid
	}
	return s.remove(ctx, id, authorize)
}

func (s *Scheduler) remove(ctx context.Context, id string, authorize CommitAuthorization) (json.RawMessage, error) {
	if !validID(id) {
		return nil, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := s.refresh(ctx)
	if err != nil {
		return nil, err
	}
	item, ok := findRecord(snapshot.Items, id)
	if !ok {
		return nil, ErrNotFound
	}
	items := []Record{}
	for _, record := range snapshot.Items {
		if record.ID != id {
			items = append(items, record)
		}
	}
	deleted := append([]string{}, snapshot.DeletedRequestIDs...)
	if item.ClientRequestID != nil {
		found := false
		for _, value := range deleted {
			if value == *item.ClientRequestID {
				found = true
			}
		}
		if !found {
			deleted = append(deleted, *item.ClientRequestID)
		}
	}
	commit := func(commitContext context.Context) error {
		return s.database.Replace(commitContext, snapshot.Revision, items, deleted, nil)
	}
	if authorize != nil {
		err = authorize(ctx, commit)
	} else {
		err = commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	if _, err = s.refresh(ctx); err != nil {
		return nil, err
	}
	s.changed()
	result := contracts.RawObject{"deleted": json.RawMessage("true")}
	result["id"], _ = json.Marshal(id)
	if item.MessageID != nil {
		result["dispatchedMessageId"], _ = json.Marshal(*item.MessageID)
		result["executionContinues"] = json.RawMessage("true")
	}
	return json.Marshal(result)
}

func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil || s.closed {
		return
	}
	run, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(schedulerPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-run.Done():
				return
			case <-ticker.C:
				_, _ = s.Tick(run)
			}
		}
	}()
}

func (s *Scheduler) Close() error {
	s.mu.Lock()
	s.closed = true
	cancel, done := s.cancel, s.done
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	return nil
}

func sortedRecords(items []Record) []Record {
	result := append([]Record{}, items...)
	rank := func(value contracts.TaskPriority) int {
		switch value {
		case contracts.TaskPriorityHigh:
			return 0
		case contracts.TaskPriorityLow:
			return 2
		default:
			return 1
		}
	}
	sort.SliceStable(result, func(a, b int) bool {
		left, right := rank(priority(result[a])), rank(priority(result[b]))
		if left != right {
			return left < right
		}
		return result[a].At < result[b].At
	})
	return result
}
