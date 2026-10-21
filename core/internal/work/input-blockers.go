package work

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

const (
	maxPendingUserRequests       = 64
	maxBlockerQuestions          = 8
	maxBlockerQuestionCharacters = 5_000
	unsupportedRequestCode       = -32601
	backgroundInputInstruction   = "Ask the human in the existing chat and wait for their reply. This client does not support requestUserInput forms."
)

type rpcErrorReplier interface {
	ReplyError(context.Context, runtime.RPCID, int, string) error
}

func (value *Engine) replyRequestError(ctx context.Context, event runtime.Event, message string) error {
	if !event.IsRequest() {
		return nil
	}
	if worker, supported := value.worker.(rpcErrorReplier); supported {
		return worker.ReplyError(ctx, event.ID.Value, unsupportedRequestCode, message)
	}
	return value.worker.Reply(ctx, event.ID.Value, raw(contracts.RawObject{"success": raw(false), "contentItems": raw([]contracts.RawObject{{"type": raw("inputText"), "text": raw(message)}})}))
}

// Background work exposes its blocker in the existing chat even when no
// browser is open. A provider form is rejected, never synthesized or replayed;
// the ordinary human reply remains the only source of new input.
func (value *Engine) requestChatInput(ctx context.Context, event runtime.Event, active *execution) error {
	value.mu.Lock()
	if !value.currentLocked(active) || active.finishing || active.stopRequested || active.unknown {
		value.mu.Unlock()
		return value.rejectEvent(ctx, event)
	}
	if active.requestNotices == nil {
		active.requestNotices = make(map[string]bool)
	}
	key := event.ID.Value.Key()
	if active.requestNotices[key] {
		value.mu.Unlock()
		return nil
	}
	if len(active.requestNotices) >= maxPendingUserRequests {
		value.mu.Unlock()
		return value.replyRequestError(ctx, event, "The input request limit was reached. Ask in the existing chat.")
	}
	active.requestNotices[key] = true
	active.waiting = true
	if err := value.syncWaitingLocked(active); err != nil {
		value.mu.Unlock()
		return err
	}

	text := i18n.Translate(value.store.Snapshot().Settings.Language, "I need your input to continue this task.", "继续这个任务需要你提供信息。")
	var questions []contracts.RawObject
	if json.Unmarshal(event.Params["questions"], &questions) == nil {
		for index, question := range questions {
			if index >= maxBlockerQuestions {
				break
			}
			units, err := contracts.DecodeJSONTextUnits(question["question"])
			if err != nil || len(units) == 0 {
				continue
			}
			var prompt string
			_ = json.Unmarshal(contracts.EncodeJSONTextUnits(units[:min(len(units), maxBlockerQuestionCharacters)]), &prompt)
			text += "\n\n" + prompt
		}
	}
	err := value.publishBlockerLocked(active, text, "input")
	value.changeLocked()
	value.mu.Unlock()
	if err != nil {
		return err
	}
	return value.replyRequestError(ctx, event, backgroundInputInstruction)
}

func (value *Engine) publishBlockerLocked(active *execution, text, kind string) error {
	text = value.redact(text)
	if contracts.TrimText(text) == "" {
		return nil
	}
	if active.deliveredTexts != nil && active.deliveredTexts[text] {
		return nil
	}
	message, err := value.store.Add(value.ctx, &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: text, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), TaskID: contracts.Some(active.messageID), WorkID: active.workID})
	if err != nil {
		return err
	}
	active.assistantIDs = append(active.assistantIDs, message.ID)
	if active.deliveredTexts == nil {
		active.deliveredTexts = make(map[string]bool)
	}
	active.deliveredTexts[text] = true
	active.inputDelivered = true
	active.blockerSequence++
	_, err = value.store.AddCompletion(value.ctx, active.turnID+":"+kind+":"+strconv.Itoa(active.blockerSequence), []string{message.ID}, contracts.Some(active.messageID), nil)
	return err
}
