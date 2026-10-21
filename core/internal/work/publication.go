package work

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

type quietOutput struct {
	text    string
	phase   string
	ready   bool
	waiting bool
}

type explicitDeliverables interface {
	ArchiveExplicit(context.Context, files.ArchiveInput) ([]contracts.Attachment, error)
}

func (value *Engine) bufferQuietText(active *execution, text string) {
	active.quietTexts = slices.DeleteFunc(active.quietTexts, func(prior quietOutput) bool { return prior.text == text })
	active.quietTexts = append(active.quietTexts, quietOutput{text: text, ready: active.record != nil && !workstate.Unfinished(active.record), waiting: active.waiting || active.planWaiting || active.credentialWaits > 0})
	length := 0
	for _, item := range active.quietTexts {
		length += contracts.UTF16Length(item.text)
	}
	for len(active.quietTexts) > workstate.ObservedItems || length > runtimeOutputCharacters {
		length -= contracts.UTF16Length(active.quietTexts[0].text)
		active.quietTexts = active.quietTexts[1:]
	}
}

const runtimeOutputCharacters = 120_000

func (value *Engine) publicationText(active *execution, status, final contracts.TaskStatus) (string, bool) {
	result := status == contracts.TaskStatusCompleted && final == contracts.TaskStatusReview && active.record != nil && !workstate.Unfinished(active.record) && !active.waiting && !active.planWaiting && active.credentialWaits == 0
	input := status == contracts.TaskStatusCompleted && (active.waiting || active.planWaiting || active.credentialWaits > 0)
	failure := status == contracts.TaskStatusFailed && !active.cancelRequested && !active.pauseOnly
	if !result && !input && !failure {
		return "", false
	}
	if failure {
		return i18n.Translate(value.store.Snapshot().Settings.Language, "The task stopped before completion.", "任务尚未完成就停止了。"), true
	}
	ordinary := []quietOutput{}
	for _, id := range active.outputOrder {
		text := active.outputs[id]
		if contracts.TrimText(text) == "" {
			continue
		}
		item := active.outputMeta[id]
		item.text = text
		ordinary = append(ordinary, item)
	}
	last := quietOutput{}
	for _, item := range ordinary {
		if last.phase != "final_answer" || item.phase == "final_answer" {
			last = item
		}
	}
	if input {
		if active.inputDelivered {
			return "", false
		}
		chosen := last
		for _, item := range append(append([]quietOutput{}, active.quietTexts...), ordinary...) {
			if item.waiting {
				chosen = item
			}
		}
		return chosen.text, contracts.TrimText(chosen.text) != ""
	}
	parts := []string{}
	for _, item := range active.quietTexts {
		if item.ready && !slices.Contains(parts, item.text) {
			parts = append(parts, item.text)
		}
	}
	if last.text != "" && !slices.Contains(parts, last.text) {
		parts = append(parts, last.text)
	}
	text := strings.Join(parts, "\n\n")
	if text == "" || contracts.UTF16Length(text) > runtimeOutputCharacters {
		text = last.text
		if text == "" && len(active.quietTexts) > 0 {
			text = active.quietTexts[len(active.quietTexts)-1].text
		}
	}
	return text, true
}

func (value *Engine) publishContinuation(active *execution, status, final contracts.TaskStatus) (string, bool, error) {
	text, permitted := value.publicationText(active, status, final)
	if !permitted {
		return "", false, nil
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if !value.currentLocked(active) {
		return "", false, ErrStaleOwner
	}
	buffered := value.quietFiles[active.workID]
	if contracts.TrimText(text) == "" && len(buffered) == 0 {
		return "", false, nil
	}
	message, err := value.store.Add(value.ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: value.redact(text), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), WorkID: active.workID, TaskID: contracts.Some(active.messageID)})
	if err != nil {
		return "", false, err
	}
	active.assistantIDs = append(active.assistantIDs, message.ID)
	if len(buffered) > 0 {
		if _, err := value.attachLocked(value.ctx, active, buffered); err != nil {
			return "", false, err
		}
	}
	value.clearQuietFilesLocked(active.workID)
	return message.ID, true, nil
}

func (value *Engine) archiveFinalOutputs(active *execution) {
	text := []string{}
	for _, id := range active.outputOrder {
		text = append(text, active.outputs[id])
	}
	var archived []contracts.Attachment
	var err error
	if value.options.Deliverables != nil {
		archived, err = value.options.Deliverables.Archive(value.ctx, value.outputDirectory(active.conversationID), strings.Join(text, "\n\n"), active.baseline)
	}
	if err != nil {
		value.notice("The output files could not be added to chat. Check the work computer for the task's files.")
		return
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if !value.currentLocked(active) || active.unknown {
		return
	}
	if active.humanResponse && active.workID != "" {
		archived = append(append([]contracts.Attachment{}, value.quietFiles[active.workID]...), archived...)
	}
	if _, err := value.attachLocked(value.ctx, active, archived); err != nil {
		value.signalLocked("notice", raw("The output files could not be added to chat."))
	} else if active.humanResponse {
		value.clearQuietFilesLocked(active.workID)
	}
}

func (value *Engine) archiveOutputLinks(ctx context.Context, active *execution, text string) {
	if _, available := value.options.Deliverables.(explicitDeliverables); !available || !strings.Contains(text, "](") {
		return
	}
	archived, err := value.archiveExplicit(ctx, active, text, nil)
	if err != nil {
		value.notice("The output files could not be added to chat. Check the work computer for the task's files.")
		return
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	if !value.currentLocked(active) || active.finishing || active.stopRequested || active.unknown {
		return
	}
	if active.attemptID != "" && !active.humanResponse {
		err = value.bufferQuietFilesLocked(active.workID, archived)
	} else {
		_, err = value.attachLocked(ctx, active, archived)
	}
	if err != nil {
		value.signalLocked("notice", raw("The output files could not be added to chat."))
	}
}

func (value *Engine) archiveExplicit(ctx context.Context, active *execution, text string, paths []string) ([]contracts.Attachment, error) {
	collector, available := value.options.Deliverables.(explicitDeliverables)
	if !available {
		return nil, ErrStaleOwner
	}
	current := func() bool {
		value.mu.Lock()
		defer value.mu.Unlock()
		return value.currentLocked(active) && !active.finishing && !active.stopRequested
	}
	return collector.ArchiveExplicit(ctx, files.ArchiveInput{OutputDirectory: value.outputDirectory(active.conversationID), Text: text, ExplicitPaths: paths, OnlyExplicit: true, Baseline: json.RawMessage(active.baseline), IsCurrent: current})
}
