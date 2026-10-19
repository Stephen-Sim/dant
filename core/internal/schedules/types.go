package schedules

import (
	"encoding/json"
	"math"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const MaxRecordBytes = 1024 * 1024
const RunHistoryLimit = 300

type Receipt struct {
	MessageID      string   `json:"messageId"`
	WorkID         *string  `json:"workId,omitempty"`
	TurnID         *string  `json:"turnId,omitempty"`
	At             *float64 `json:"at,omitempty"`
	DispatchedAt   *float64 `json:"dispatchedAt,omitempty"`
	TerminalStatus *string  `json:"terminalStatus,omitempty"`
	TerminalAt     *float64 `json:"terminalAt,omitempty"`
}

type Record struct {
	ID                  string                                       `json:"id"`
	Text                string                                       `json:"text"`
	At                  float64                                      `json:"at"`
	Cron                contracts.Optional[string]                   `json:"cron,omitzero"`
	Priority            contracts.Optional[contracts.TaskPriority]   `json:"priority,omitzero"`
	TimeZone            *string                                      `json:"timeZone,omitempty"`
	Status              contracts.ScheduleStatus                     `json:"status"`
	Enabled             *bool                                        `json:"enabled,omitempty"`
	CreatedAt           *float64                                     `json:"createdAt,omitempty"`
	UpdatedAt           *float64                                     `json:"updatedAt,omitempty"`
	ClientRequestID     *string                                      `json:"clientRequestId,omitempty"`
	CreationFingerprint contracts.Optional[string]                   `json:"creationFingerprint,omitzero"`
	MessageID           *string                                      `json:"messageId,omitempty"`
	LastRunAt           *float64                                     `json:"lastRunAt,omitempty"`
	DispatchedAt        *float64                                     `json:"dispatchedAt,omitempty"`
	RunHistory          []Receipt                                    `json:"runHistory,omitempty"`
	TaskStatus          contracts.Optional[contracts.ChatTaskStatus] `json:"taskStatus,omitzero"`
	Extra               contracts.RawObject                          `json:"-"`
	LegacyText          contracts.LegacyJSON                         `json:"-"`
}

func validID(value string) bool {
	if value == "" || contracts.UTF16Length(value) > 128 {
		return false
	}
	for _, character := range value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func validInstant(value float64) bool {
	return finite(value) && math.Trunc(value) == value && value > 0 && value <= float64(MaxTime)
}

func priority(record Record) contracts.TaskPriority {
	if value, ok := record.Priority.Get(); ok {
		return value
	}
	return contracts.TaskPriorityNormal
}

func recordZone(record Record) string {
	if record.TimeZone != nil {
		return *record.TimeZone
	}
	return "UTC"
}

func decodeRecord(raw json.RawMessage) (Record, error) {
	object, err := contracts.DecodeObject(raw, MaxRecordBytes)
	if err != nil {
		return Record{}, ErrInvalid
	}
	type plain Record
	var record plain
	if json.Unmarshal(raw, &record) != nil || !record.Status.Valid() || !finite(record.At) {
		return Record{}, ErrInvalid
	}
	for _, name := range []string{"id", "text", "at", "status"} {
		if value, ok := object[name]; !ok || string(value) == "null" {
			return Record{}, ErrInvalid
		}
	}
	if !contracts.ValidUnicodeJSON(object["id"]) {
		return Record{}, ErrInvalid
	}
	if value, exists := object["runHistory"]; exists && string(value) != "null" {
		var receipts []json.RawMessage
		if json.Unmarshal(value, &receipts) != nil {
			return Record{}, ErrInvalid
		}
		for _, raw := range receipts {
			fields, err := contracts.DecodeObject(raw, MaxRecordBytes)
			if err != nil {
				return Record{}, ErrInvalid
			}
			var id string
			if value, ok := fields["messageId"]; !ok || string(value) == "null" || json.Unmarshal(value, &id) != nil {
				return Record{}, ErrInvalid
			}
			for _, name := range []string{"workId", "turnId", "at", "dispatchedAt", "terminalStatus", "terminalAt"} {
				if value, ok := fields[name]; ok && string(value) == "null" {
					return Record{}, ErrInvalid
				}
			}
		}
	}
	for _, receipt := range record.RunHistory {
		for _, value := range []*float64{receipt.At, receipt.DispatchedAt, receipt.TerminalAt} {
			if value != nil && !finite(*value) {
				return Record{}, ErrInvalid
			}
		}
	}
	for _, name := range []string{"priority", "timeZone", "enabled", "createdAt", "updatedAt", "clientRequestId", "messageId", "lastRunAt", "dispatchedAt", "runHistory", "taskStatus"} {
		if value, ok := object[name]; ok && string(value) == "null" {
			return Record{}, ErrInvalid
		}
	}
	if record.Priority.Present && (record.Priority.Null || !record.Priority.Value.Valid()) {
		return Record{}, ErrInvalid
	}
	for _, value := range []*float64{record.CreatedAt, record.UpdatedAt, record.LastRunAt, record.DispatchedAt} {
		if value != nil && !finite(*value) {
			return Record{}, ErrInvalid
		}
	}
	record.Extra = object
	if strings.Contains(string(object["text"]), `\u`) {
		record.LegacyText = contracts.LegacyJSON{Original: contracts.RawObject{"text": object["text"]}, Decoded: map[string]string{"text": record.Text}}
	}
	return Record(record), nil
}

func (record Record) MarshalJSON() ([]byte, error) {
	type plain Record
	known, err := json.Marshal(plain(record))
	if err != nil {
		return nil, err
	}
	var fields contracts.RawObject
	if json.Unmarshal(known, &fields) != nil {
		return nil, ErrInvalid
	}
	if original, ok := record.LegacyText.Original["text"]; ok && record.LegacyText.Decoded["text"] == record.Text {
		fields["text"] = original
	}
	reserved := map[string]bool{}
	for _, name := range strings.Fields("id text at cron priority timeZone status enabled createdAt updatedAt clientRequestId creationFingerprint messageId lastRunAt dispatchedAt runHistory taskStatus") {
		reserved[name] = true
	}
	for key, value := range record.Extra {
		if !reserved[key] {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}

type Snapshot struct {
	Revision          int64    `json:"revision"`
	Items             []Record `json:"items"`
	DeletedRequestIDs []string `json:"deletedRequestIds"`
}

type ScheduledMessage struct {
	ID               string                 `json:"id"`
	Role             contracts.Role         `json:"role"`
	Text             string                 `json:"text"`
	Status           contracts.TaskStatus   `json:"status"`
	Scheduled        bool                   `json:"scheduled"`
	ScheduleID       string                 `json:"scheduleId"`
	ScheduledAt      int64                  `json:"scheduledAt"`
	ProgressPriority contracts.TaskPriority `json:"progressPriority"`
}

func (message ScheduledMessage) valid() bool {
	return validID(message.ID) && validID(message.ScheduleID) && message.Role == contracts.RoleUser && trim(message.Text) != "" && !strings.ContainsRune(message.Text, 0) && message.Status == contracts.TaskStatusQueued && message.Scheduled && message.ScheduledAt > 0 && message.ScheduledAt <= MaxTime && message.ProgressPriority.Valid()
}

func (message ScheduledMessage) Chat() *contracts.ChatMessage {
	return &contracts.ChatMessage{
		ID:               message.ID,
		Role:             message.Role,
		Text:             message.Text,
		Status:           contracts.Some(contracts.MessageStatus(message.Status)),
		Scheduled:        true,
		ScheduleID:       message.ScheduleID,
		ScheduledAt:      contracts.Some(float64(message.ScheduledAt)),
		ProgressPriority: contracts.Some(message.ProgressPriority),
		Reactions:        []string{},
	}
}

func trim(value string) string { return contracts.TrimText(value) }

type Dispatch struct {
	Message ScheduledMessage                `json:"message"`
	Owner   string                          `json:"owner"`
	Phase   contracts.ScheduleDispatchPhase `json:"phase"`
}

type Claim struct {
	Revision  int64
	Candidate Record
	Claimed   Record
	Message   ScheduledMessage
	Owner     string
}
