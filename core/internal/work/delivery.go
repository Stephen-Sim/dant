package work

import (
	"context"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
	"slices"
	"strings"
)

const MaxDeliveredFiles = 5

func (value *Engine) DeliverText(ctx context.Context, text string, owner ToolContext) (json.RawMessage, error) {
	if contracts.TrimText(text) == "" || contracts.UTF16Length(text) > 100_000 || owner.IsCurrent == nil || !owner.IsCurrent() {
		return nil, ErrStaleOwner
	}
	text = value.redact(text)
	value.mu.Lock()
	result, err := value.deliverTextLocked(ctx, text, owner)
	active := value.active
	value.mu.Unlock()
	if err == nil && active != nil {
		value.archiveOutputLinks(ctx, active, text)
	}
	return result, err
}

func (value *Engine) deliverTextLocked(ctx context.Context, text string, owner ToolContext) (json.RawMessage, error) {
	active := value.active
	if active == nil || !value.currentLocked(active) || active.turnID != owner.TurnID || active.stopRequested || active.finishing {
		return nil, ErrStaleOwner
	}
	if active.deliveredTexts == nil {
		active.deliveredTexts = make(map[string]bool)
	}
	if active.deliveredTexts[text] {
		return raw(contracts.RawObject{"sent": raw(false), "alreadyDelivered": raw(true)}), nil
	}
	if len(active.assistantIDs) >= workstate.ObservedItems {
		return nil, runtime.ErrBackpressure
	}
	if active.attemptID != "" && !active.humanResponse {
		value.bufferQuietText(active, text)
		return raw(contracts.RawObject{"sent": raw(false), "quiet": raw(true), "buffered": raw(true)}), nil
	}
	message, err := value.store.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: text, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), TaskID: contracts.Some(active.messageID), WorkID: active.workID})
	if err != nil {
		return nil, err
	}
	active.assistantIDs = append(active.assistantIDs, message.ID)
	active.deliveredTexts[text] = true
	value.changeLocked()
	return raw(contracts.RawObject{"sent": raw(true), "messageId": raw(message.ID)}), nil
}

func attachmentIdentity(file contracts.Attachment) string {
	if file.SHA256 != "" {
		return file.SHA256
	}
	if file.Hash != "" {
		return file.Hash
	}
	return file.ID
}

func (value *Engine) DeliverAttachments(ctx context.Context, attachments []contracts.Attachment, owner ToolContext) (json.RawMessage, error) {
	if owner.IsCurrent == nil || !owner.IsCurrent() {
		return nil, ErrStaleOwner
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	active := value.active
	if active == nil || !value.currentLocked(active) || active.turnID != owner.TurnID || active.stopRequested || active.finishing {
		return nil, ErrStaleOwner
	}
	if active.attemptID != "" && !active.humanResponse {
		if err := value.bufferQuietFilesLocked(active.workID, attachments); err != nil {
			return nil, err
		}
		return raw(contracts.RawObject{"sent": raw(false), "quiet": raw(true), "buffered": raw(true)}), nil
	}
	files, err := value.attachLocked(ctx, active, attachments)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, store.ErrInvalidState
	}
	return raw(contracts.RawObject{"sent": raw(true), "files": raw(files)}), nil
}

func (value *Engine) bufferQuietFilesLocked(workID string, attachments []contracts.Attachment) error {
	for _, file := range attachments {
		if file.ID == "" {
			return store.ErrInvalidState
		}
	}
	if _, present := value.quietFiles[workID]; !present {
		value.quietFileOrder = append(value.quietFileOrder, workID)
	}
	existing := value.quietFiles[workID]
	for _, file := range attachments {
		key := quietFileIdentity(file)
		existing = slices.DeleteFunc(existing, func(prior contracts.Attachment) bool { return quietFileIdentity(prior) == key })
		existing = append(existing, file)
	}
	if len(existing) > MaxDeliveredFiles {
		existing = existing[len(existing)-MaxDeliveredFiles:]
	}
	value.quietFiles[workID] = existing
	for len(value.quietFileOrder) > store.MaxWorkRecords {
		delete(value.quietFiles, value.quietFileOrder[0])
		value.quietFileOrder = value.quietFileOrder[1:]
	}
	return nil
}

func quietFileIdentity(file contracts.Attachment) string {
	if file.SourcePath != "" {
		return file.SourcePath
	}
	return attachmentIdentity(file)
}

func (value *Engine) clearQuietFilesLocked(workID string) {
	delete(value.quietFiles, workID)
	value.quietFileOrder = slices.DeleteFunc(value.quietFileOrder, func(id string) bool { return id == workID })
}

func (value *Engine) attachLocked(ctx context.Context, active *execution, attachments []contracts.Attachment) ([]contracts.Attachment, error) {
	state := value.store.Snapshot()
	existing := []string{}
	var target *contracts.ChatMessage
	for _, id := range active.assistantIDs {
		message, err := store.FindMessage(&state, id)
		if err != nil {
			continue
		}
		target = message
		for _, file := range message.Attachments {
			existing = append(existing, attachmentIdentity(file))
		}
	}
	selected := []contracts.Attachment{}
	for _, file := range attachments {
		if file.ID == "" {
			return nil, store.ErrInvalidState
		}
		identity := attachmentIdentity(file)
		if slices.Contains(existing, identity) || len(existing) >= MaxDeliveredFiles {
			continue
		}
		selected = append(selected, file)
		existing = append(existing, identity)
	}
	if len(selected) == 0 {
		return selected, nil
	}
	if target == nil {
		message, err := value.store.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), TaskID: contracts.Some(active.messageID), WorkID: active.workID})
		if err != nil {
			return nil, err
		}
		active.assistantIDs = append(active.assistantIDs, message.ID)
		target = message
	}
	_, err := value.store.Update(ctx, target.ID, patch(contracts.RawObject{"attachments": raw(append(target.Attachments, selected...))}))
	value.changeLocked()
	return selected, err
}

func (value *Engine) Thread(ctx context.Context) (string, error) {
	if err := value.ensureEvents(); err != nil {
		return "", err
	}
	value.mu.Lock()
	state := value.store.Snapshot()
	active := value.active
	if _, present := state.Extra[executorStopFenceKey]; present {
		value.mu.Unlock()
		return "", ErrUnknown
	}
	if active != nil {
		value.mu.Unlock()
		return value.thread(active)
	}
	if value.closed || value.maintenance || value.takeover || value.acquiring {
		value.mu.Unlock()
		return "", ErrBusy
	}
	if value.openingThread {
		ready := value.threadReady
		value.mu.Unlock()
		select {
		case <-ready:
			return value.Thread(ctx)
		case <-ctx.Done():
			return "", ctx.Err()
		case <-value.ctx.Done():
			return "", ErrClosed
		}
	}
	value.openingThread = true
	value.threadReady = make(chan struct{})
	value.mu.Unlock()
	defer func() {
		value.mu.Lock()
		value.openingThread = false
		close(value.threadReady)
		value.changeLocked()
		value.mu.Unlock()
		value.Wake()
	}()
	return value.openThread(ctx, state.ConversationID, func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return !value.closed && !value.takeover && !value.acquiring && value.store.ConversationID() == state.ConversationID
	})
}

func (value *Engine) Instructions() string {
	text, err := value.InstructionsContext(value.ctx)
	if err != nil {
		return ""
	}
	return text
}

func (value *Engine) OutputDirectory() string {
	return value.outputDirectory(value.store.ConversationID())
}

func (value *Engine) CombinedOutput() string {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.active == nil {
		return ""
	}
	texts := []string{}
	for _, id := range value.active.outputOrder {
		texts = append(texts, value.active.outputs[id])
	}
	return strings.Join(texts, "\n\n")
}
