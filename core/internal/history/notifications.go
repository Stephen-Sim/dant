package history

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const (
	MaxNotificationBytes      = 4 * 1024 * 1024
	MaxNotificationRecords    = 1000
	NotificationPreviewLength = 240
	NotificationGrace         = 3 * time.Second
)

var ErrNotificationState = errors.New("notification_state_invalid")
var ErrNotificationSave = errors.New("notification_save_failed")

type NotificationOptions struct {
	Now   func() time.Time
	Grace time.Duration
}
type notificationRecord struct {
	ID             string   `json:"id"`
	ConversationID *string  `json:"conversationId"`
	MessageID      *string  `json:"messageId"`
	At             float64  `json:"at"`
	ObservedAt     float64  `json:"observedAt"`
	Eligible       bool     `json:"eligible"`
	ReadAt         *float64 `json:"readAt,omitempty"`
	DeliveredAt    *float64 `json:"deliveredAt,omitempty"`
}
type notificationState struct {
	Enabled   bool                          `json:"enabled"`
	EnabledAt *float64                      `json:"enabledAt"`
	Records   map[string]notificationRecord `json:"records"`
}
type Notification struct {
	ID             string  `json:"id"`
	ConversationID *string `json:"conversationId"`
	MessageID      *string `json:"messageId"`
	Title          string  `json:"title"`
	Body           string  `json:"body"`
}
type NotificationHub struct {
	mu       sync.Mutex
	file     string
	now      func() time.Time
	grace    time.Duration
	state    notificationState
	previews map[string]string
}

func OpenNotificationHub(directory string, options NotificationOptions) (*NotificationHub, error) {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Grace == 0 {
		options.Grace = NotificationGrace
	}
	if options.Grace < 0 {
		return nil, ErrNotificationState
	}
	if _, err := files.OrdinaryDirectory(directory, true); err != nil {
		return nil, ErrNotificationSave
	}
	hub := &NotificationHub{file: filepath.Join(directory, "notifications.json"), now: options.Now, grace: options.Grace, state: notificationState{Records: make(map[string]notificationRecord)}, previews: make(map[string]string)}
	raw, err := files.ReadRegular(hub.file, MaxNotificationBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return hub, nil
	}
	if err != nil {
		return nil, ErrNotificationState
	}
	object, err := contracts.DecodeObject(raw, MaxNotificationBytes)
	if err != nil {
		return nil, ErrNotificationState
	}
	_ = json.Unmarshal(object["enabled"], &hub.state.Enabled)
	_ = json.Unmarshal(object["enabledAt"], &hub.state.EnabledAt)
	if records, err := contracts.DecodeObject(object["records"], MaxNotificationBytes); err == nil {
		for key, raw := range records {
			var entry notificationRecord
			if !contracts.ValidUnicodeJSON(raw) || json.Unmarshal(raw, &entry) != nil || entry.ID == "" || entry.ID != key || !notificationTime(entry.At) || !notificationTime(entry.ObservedAt) {
				continue
			}
			hub.state.Records[key] = entry
		}
	}
	return hub, nil
}

func notificationTime(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func (value *NotificationHub) timestamp() float64 {
	return float64(value.now().UnixMilli())
}

func (value *NotificationHub) save(ctx context.Context, next notificationState) error {
	encoded, err := json.Marshal(next)
	if err != nil || len(encoded) > MaxNotificationBytes {
		return ErrNotificationSave
	}
	if err = files.WriteAtomic(ctx, value.file, encoded, 0o600); err != nil {
		return ErrNotificationSave
	}
	value.state = next
	return nil
}

func cloneNotificationState(state notificationState) notificationState {
	next := state
	next.Records = make(map[string]notificationRecord, len(state.Records))
	for key, entry := range state.Records {
		next.Records[key] = entry
	}
	return next
}

func (value *NotificationHub) Configure(ctx context.Context, enabled bool) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.state.Enabled == enabled {
		return nil
	}
	next := cloneNotificationState(value.state)
	next.Enabled = enabled
	if enabled {
		now := value.timestamp()
		next.EnabledAt = &now
	}
	return value.save(ctx, next)
}

func (value *NotificationHub) Observe(ctx context.Context, snapshot contracts.WorkerSnapshot) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	next := cloneNotificationState(value.state)
	messages := make(map[string]*contracts.ChatMessage, len(snapshot.Messages))
	for _, message := range snapshot.Messages {
		if message != nil {
			messages[message.ID] = message
		}
	}
	previews := make(map[string]string)
	changed := false
	retained := make(map[string]bool)
	for _, completion := range snapshot.Completions {
		if completion.ID == "" || !completion.At.Present || completion.At.Null || !notificationTime(completion.At.Value) {
			continue
		}
		retained[completion.ID] = true
		record, exists := next.Records[completion.ID]
		if !exists {
			conversation := snapshot.ConversationID
			record = notificationRecord{ID: completion.ID, ConversationID: &conversation, At: completion.At.Value, ObservedAt: value.timestamp(), Eligible: next.Enabled && next.EnabledAt != nil && completion.At.Value >= *next.EnabledAt}
			if len(completion.MessageIDs) > 0 {
				last := completion.MessageIDs[len(completion.MessageIDs)-1]
				record.MessageID = &last
			}
			changed = true
		}
		if record.ConversationID != nil && *record.ConversationID == snapshot.ConversationID {
			previews[completion.ID] = completionPreview(completion, messages, snapshot.ConversationID)
		}
		read := completion.ReadAt.Value != 0
		if !read && len(completion.MessageIDs) > 0 {
			read = true
			for _, id := range completion.MessageIDs {
				message := messages[id]
				var receipt float64
				if message != nil {
					_ = json.Unmarshal(message.Receipt["readAt"], &receipt)
				}
				read = read && message != nil && (message.Read || message.VisibleAt.Value != 0 || receipt != 0)
			}
		}
		if read && record.ReadAt == nil {
			now := value.timestamp()
			record.ReadAt = &now
			changed = true
		}
		next.Records[completion.ID] = record
	}
	if len(next.Records) > MaxNotificationRecords {
		ordered := make([]notificationRecord, 0, len(next.Records))
		for _, entry := range next.Records {
			ordered = append(ordered, entry)
		}
		sort.Slice(ordered, func(i, j int) bool {
			if ordered[i].At == ordered[j].At {
				return ordered[i].ID < ordered[j].ID
			}
			return ordered[i].At > ordered[j].At
		})
		for _, entry := range ordered[MaxNotificationRecords:] {
			if !retained[entry.ID] {
				delete(next.Records, entry.ID)
				changed = true
			}
		}
	}
	if changed {
		if err := value.save(ctx, next); err != nil {
			return err
		}
	}
	value.previews = previews
	return nil
}

func (value *NotificationHub) Pending() []Notification {
	value.mu.Lock()
	defer value.mu.Unlock()
	result := []Notification{}
	if !value.state.Enabled {
		return result
	}
	for _, record := range value.state.Records {
		if record.Eligible && record.ReadAt == nil && record.DeliveredAt == nil && value.timestamp()-record.ObservedAt >= float64(value.grace.Milliseconds()) {
			item := Notification{ID: record.ID, Title: "dant", Body: value.previews[record.ID]}
			if record.ConversationID != nil {
				id := *record.ConversationID
				item.ConversationID = &id
			}
			if record.MessageID != nil {
				id := *record.MessageID
				item.MessageID = &id
			}
			result = append(result, item)
		}
	}
	slices.SortFunc(result, func(a, b Notification) int {
		return strings.Compare(a.ID, b.ID)
	})
	return result
}

func (value *NotificationHub) Acknowledge(ctx context.Context, id string) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	record, exists := value.state.Records[id]
	if !exists {
		return ErrNotificationState
	}
	if record.DeliveredAt != nil {
		return nil
	}
	next := cloneNotificationState(value.state)
	now := value.timestamp()
	record.DeliveredAt = &now
	next.Records[id] = record
	return value.save(ctx, next)
}

func completionPreview(completion contracts.Completion, messages map[string]*contracts.ChatMessage, conversationID string) string {
	deliveries := []*contracts.ChatMessage{}
	for index := len(completion.MessageIDs) - 1; index >= 0; index-- {
		message := messages[completion.MessageIDs[index]]
		if message == nil || message.Role != contracts.RoleAssistant || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) {
			continue
		}
		var source string
		_ = json.Unmarshal(message.Source["conversationId"], &source)
		if source != "" && source != conversationID {
			continue
		}
		deliveries = append(deliveries, message)
	}
	for _, message := range deliveries {
		if text := boundedPreview(message.Text); text != "" {
			return text
		}
	}
	for _, message := range deliveries {
		names := []string{}
		for _, file := range message.Attachments[:min(3, len(message.Attachments))] {
			name := plainNotificationText(path.Base(strings.ReplaceAll(file.Name, "\\", "/")))
			if name != "" {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			return boundedPreview(strings.Join(names, " · "))
		}
	}
	return ""
}
