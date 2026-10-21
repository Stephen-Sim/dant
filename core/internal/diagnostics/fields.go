package diagnostics

import (
	"encoding/json"
	"math"
	"regexp"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

var token = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`)
var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
var eventPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,79}$`)
var secretLike = regexp.MustCompile(`(?i)(?:^|[.:/])(?:sk[-_]|gh[pousr]_|xox[baprs]-|Bearer|eyJ[A-Za-z0-9_-]{10,}\.)`)

// Fields is the complete operational metadata boundary. It has no message,
// payload, exception, arbitrary URL, header or process-output field.
type Fields struct {
	Code           string `json:"code,omitempty"`
	Status         string `json:"status,omitempty"`
	Role           string `json:"role,omitempty"`
	Reason         string `json:"reason,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Phase          string `json:"phase,omitempty"`
	Stage          string `json:"stage,omitempty"`
	Source         string `json:"source,omitempty"`
	Operation      string `json:"operation,omitempty"`
	Signal         string `json:"signal,omitempty"`
	Transport      string `json:"transport,omitempty"`
	ThreadID       string `json:"threadId,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	CallID         string `json:"callId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	TaskID         string `json:"taskId,omitempty"`
	ItemID         string `json:"itemId,omitempty"`
	Method         string `json:"method,omitempty"`
	Route          string `json:"route,omitempty"`
	Version        string `json:"version,omitempty"`
	TargetVersion  string `json:"targetVersion,omitempty"`
	RunningVersion string `json:"runningVersion,omitempty"`
	ItemType       string `json:"itemType,omitempty"`
	ItemStatus     string `json:"itemStatus,omitempty"`

	Bytes        *int64   `json:"bytes,omitempty"`
	EventBytes   *int64   `json:"eventBytes,omitempty"`
	QueuedBytes  *int64   `json:"queuedBytes,omitempty"`
	QueuedEvents *int64   `json:"queuedEvents,omitempty"`
	DurationMS   *float64 `json:"durationMs,omitempty"`
	Count        *int64   `json:"count,omitempty"`
	Attempt      *int64   `json:"attempt,omitempty"`
	ExitCode     *int64   `json:"exitCode,omitempty"`

	ExecutorStopped *bool `json:"executorStopped,omitempty"`
	Confirmed       *bool `json:"confirmed,omitempty"`
	UnknownOutcome  *bool `json:"unknownOutcome,omitempty"`
	Connected       *bool `json:"connected,omitempty"`
	Available       *bool `json:"available,omitempty"`
	Active          *bool `json:"active,omitempty"`
	Cached          *bool `json:"cached,omitempty"`
}

var textKeys = []string{"code", "status", "role", "reason", "provider", "phase", "stage", "source", "operation", "signal", "transport"}
var idKeys = []string{"threadId", "turnId", "callId", "requestId", "messageId", "taskId", "itemId"}
var versionKeys = []string{"version", "targetVersion", "runningVersion"}
var numberKeys = []string{"bytes", "eventBytes", "queuedBytes", "queuedEvents", "durationMs", "count", "attempt", "exitCode"}
var booleanKeys = []string{"executorStopped", "confirmed", "unknownOutcome", "connected", "available", "active", "cached"}
var itemTypes = []string{"userMessage", "hookPrompt", "agentMessage", "plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "enteredReviewMode", "exitedReviewMode", "contextCompaction", "other"}
var itemStatuses = []string{"inProgress", "completed", "failed", "declined", "interrupted", "cancelled"}

func safeString(value string, pattern *regexp.Regexp) bool {
	return pattern.MatchString(value) && !secretLike.MatchString(value)
}

func validVersion(value string) bool {
	_, err := updates.CompareVersions(value, value)
	return err == nil && !secretLike.MatchString(value)
}

// metadata also sanitizes persisted log records. Reading an old file must not
// expose fields that the current writer would refuse to persist.
func metadata(object contracts.RawObject) contracts.RawObject {
	result := contracts.RawObject{}
	for key, raw := range object {
		var text string
		if slices.Contains(textKeys, key) || slices.Contains(idKeys, key) ||
			slices.Contains(versionKeys, key) || slices.Contains([]string{"itemType", "itemStatus", "method", "route"}, key) {
			if json.Unmarshal(raw, &text) != nil {
				continue
			}
			valid := false
			switch {
			case slices.Contains(versionKeys, key):
				valid = validVersion(text)
			case slices.Contains(idKeys, key):
				valid = safeString(text, identifier)
			case key == "itemType":
				valid = slices.Contains(itemTypes, text)
			case key == "itemStatus":
				valid = slices.Contains(itemStatuses, text)
			case key == "method":
				valid = slices.Contains([]string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}, text)
			case key == "route":
				valid = routes[text]
			default:
				valid = safeString(text, token)
			}
			if valid {
				result[key] = append(json.RawMessage(nil), raw...)
			}
			continue
		}

		if slices.Contains(numberKeys, key) {
			var number float64
			if string(raw) != "null" && json.Unmarshal(raw, &number) == nil &&
				!math.IsNaN(number) && !math.IsInf(number, 0) && math.Abs(number) <= maxSafeInteger &&
				(key == "durationMs" || math.Trunc(number) == number) && (key == "exitCode" || number >= 0) {
				result[key] = append(json.RawMessage(nil), raw...)
			}
			continue
		}

		if slices.Contains(booleanKeys, key) {
			var flag bool
			if string(raw) != "null" && json.Unmarshal(raw, &flag) == nil {
				result[key] = append(json.RawMessage(nil), raw...)
			}
		}
	}
	return result
}
