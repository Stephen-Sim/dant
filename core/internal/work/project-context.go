package work

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const projectTextCharacters = 4000

var projectAttachmentID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type projectMemory interface {
	ReadProject(context.Context, string, string) (*memory.ProjectContext, error)
	WriteProject(context.Context, string, string, json.RawMessage) (*memory.ProjectContext, error)
}

func (value *Engine) projectMemory() projectMemory {
	bound, _ := value.options.DurableMemory.(projectMemory)
	return bound
}

func projectEntry(message *contracts.ChatMessage, redact func(string) string) json.RawMessage {
	if message == nil || !workstate.ValidID(message.ID, workstate.ReferenceIDLength) || !workstate.ValidTime(message.Time.Value) {
		return json.RawMessage("null")
	}
	text := redact(message.Text)
	encoded := raw(text)
	if text == message.Text && message.LegacyText.Decoded["text"] == text {
		if original, present := message.LegacyText.Original["text"]; present {
			encoded = original
		}
	}
	encoded, err := contracts.SliceJSONText(encoded, projectTextCharacters)
	if err != nil {
		return json.RawMessage("null")
	}
	attachments := []contracts.RawObject{}
	for _, file := range message.Attachments[:min(MaxDeliveredFiles, len(message.Attachments))] {
		if !projectAttachmentID.MatchString(file.ID) {
			continue
		}
		entry := contracts.RawObject{"id": raw(file.ID), "name": raw(workstate.SliceText(redact(file.Name), 200)), "type": raw(workstate.SliceText(redact(file.Type), 100))}
		if size, present := file.Size.Get(); present && size >= 0 && size <= files.MaxAttachmentBytes && float64(int64(size)) == size {
			entry["size"] = raw(size)
		}
		attachments = append(attachments, entry)
	}
	entry := contracts.RawObject{"messageId": raw(message.ID), "at": raw(message.Time.Value), "text": encoded, "attachments": raw(attachments)}
	if workstate.ValidID(message.TurnID.Value, workstate.ReferenceIDLength) {
		entry["turnId"] = raw(message.TurnID.Value)
	}
	return raw(entry)
}

func (value *Engine) captureProject(ctx context.Context, state contracts.State, record *contracts.WorkRecord, ownedIDs []string, at float64) (*memory.ProjectContext, error) {
	var previous *memory.ProjectContext
	var err error
	if bound := value.projectMemory(); bound != nil {
		previous, err = bound.ReadProject(ctx, state.ConversationID, record.ID)
		if err != nil {
			return nil, err
		}
	} else if record.ProjectContext != nil {
		previous, _ = memory.SafeProjectContext(raw(record.ProjectContext))
	}
	if previous == nil {
		previous = &memory.ProjectContext{Version: 1, UpdatedAt: int64(at), HumanUpdates: []memory.ProjectEntry{}, Results: []memory.ProjectEntry{}}
	}
	original := raw(previous.OriginalRequest)
	updates := make(map[string]json.RawMessage)
	results := make(map[string]json.RawMessage)
	updateOrder := []string{}
	resultOrder := []string{}
	for _, entry := range previous.HumanUpdates {
		if _, present := updates[entry.MessageID]; !present {
			updateOrder = append(updateOrder, entry.MessageID)
		}
		updates[entry.MessageID] = raw(entry)
	}
	for _, entry := range previous.Results {
		if _, present := results[entry.MessageID]; !present {
			resultOrder = append(resultOrder, entry.MessageID)
		}
		results[entry.MessageID] = raw(entry)
	}
	turns := append(append([]string{}, record.TurnIDs...), record.TurnID)
	compatible := func(message *contracts.ChatMessage) bool {
		return (message.WorkID == "" || message.WorkID == record.ID) && (message.WorkReply == nil || message.WorkReply.WorkID == record.ID) && (message.TurnID.Value == "" || slices.Contains(turns, message.TurnID.Value))
	}
	humanIDs := []string{}
	for _, message := range state.Messages {
		if message.Role != contracts.RoleUser || !compatible(message) || !(message.ID == record.MessageID.Value || message.WorkID == record.ID || message.WorkReply != nil && message.WorkReply.WorkID == record.ID || message.TurnID.Value != "" && slices.Contains(turns, message.TurnID.Value) || slices.Contains(ownedIDs, message.ID)) {
			continue
		}
		humanIDs = append(humanIDs, message.ID)
		saved := projectEntry(message, value.redact)
		if string(saved) == "null" {
			continue
		}
		if string(original) == "null" && message.ID == record.MessageID.Value {
			original = saved
			continue
		}
		var first memory.ProjectEntry
		_ = json.Unmarshal(original, &first)
		if first.MessageID != message.ID {
			if _, present := updates[message.ID]; !present {
				updateOrder = append(updateOrder, message.ID)
			}
			updates[message.ID] = saved
		}
	}
	for _, message := range state.Messages {
		if message.Role != contracts.RoleAssistant || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || !compatible(message) || !(message.WorkID == record.ID || message.TurnID.Value != "" && slices.Contains(turns, message.TurnID.Value) || slices.Contains(humanIDs, message.TaskID.Value) || slices.Contains(ownedIDs, message.ID)) {
			continue
		}
		if saved := projectEntry(message, value.redact); string(saved) != "null" {
			if _, present := results[message.ID]; !present {
				resultOrder = append(resultOrder, message.ID)
			}
			results[message.ID] = saved
		}
	}
	latest := func(entries map[string]json.RawMessage, order []string) []json.RawMessage {
		values := []json.RawMessage{}
		for _, id := range order {
			values = append(values, entries[id])
		}
		slices.SortStableFunc(values, func(left, right json.RawMessage) int {
			var first, second memory.ProjectEntry
			_ = json.Unmarshal(left, &first)
			_ = json.Unmarshal(right, &second)
			if first.At < second.At {
				return -1
			}
			if first.At > second.At {
				return 1
			}
			return 0
		})
		return values[max(0, len(values)-8):]
	}
	return memory.SafeProjectContext(raw(contracts.RawObject{"version": raw(1), "referenceDataOnly": raw(true), "updatedAt": raw(at), "originalRequest": original, "humanUpdates": raw(latest(updates, updateOrder)), "results": raw(latest(results, resultOrder))}))
}

func (value *Engine) refreshProjectLocked(ctx context.Context, record *contracts.WorkRecord, ownedIDs []string) error {
	state := value.store.Snapshot()
	current, err := store.FindWork(&state, record.ID)
	if err != nil || current.TurnID != record.TurnID {
		return ErrStaleOwner
	}
	project, err := value.captureProject(ctx, state, current, ownedIDs, value.Timestamp())
	if err != nil {
		return err
	}
	if bound := value.projectMemory(); bound != nil {
		project, err = bound.WriteProject(ctx, state.ConversationID, record.ID, raw(project))
		if err != nil {
			return err
		}
	}
	fields, err := contracts.DecodeObject(raw(project), store.MaxStateBytes)
	if err != nil {
		return err
	}
	return value.store.Mutate(ctx, func(updated *contracts.State) error {
		if updated.ConversationID != state.ConversationID {
			return ErrStaleOwner
		}
		entry, err := store.FindWork(updated, record.ID)
		if err != nil || entry.TurnID != record.TurnID {
			return ErrStaleOwner
		}
		entry.ProjectContext = fields
		record.ProjectContext = fields
		return nil
	})
}

func (value *Engine) TaskContext(ctx context.Context, workID, conversationID, turnID string) (json.RawMessage, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed || ctx.Err() != nil {
		return nil, ErrClosed
	}
	state := value.store.Snapshot()
	if state.ConversationID != conversationID {
		return nil, ErrStaleOwner
	}
	record, err := store.FindWork(&state, workID)
	if err != nil || record.TurnID != turnID || record.ProgressDismissedAt.Value > 0 {
		return nil, ErrStaleOwner
	}
	at := record.UpdatedAt
	if !workstate.ValidTime(at) {
		at = value.Timestamp()
	}
	project, err := value.captureProject(ctx, state, record, nil, at)
	if err != nil {
		return nil, err
	}
	return raw(project), nil
}

func TaskContextSnapshots(records []contracts.WorkRecord) []contracts.WorkRecord {
	result := make([]contracts.WorkRecord, len(records))
	for index, record := range records {
		result[index] = record
		result[index].ProjectContext = nil
	}
	return result
}
