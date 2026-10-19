package telegram

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func messageByID(state contracts.State, id string) *contracts.ChatMessage {
	for _, message := range state.Messages {
		if message != nil && message.ID == id {
			return message
		}
	}
	return nil
}
func mirrorRole(item *OutboxItem, state contracts.State) contracts.Role {
	if item.LocalMessageID == "" {
		return ""
	}
	if message := messageByID(state, item.LocalMessageID); message != nil {
		return message.Role
	}
	return item.MirrorRole
}

func (gateway *Gateway) prepareLocked(ctx context.Context) error {
	owner, bot := gateway.config.Owner, gateway.config.Bot
	if owner == nil || bot == nil {
		return nil
	}
	state := gateway.options.Store.Snapshot()
	for _, item := range gateway.config.Outbox {
		if item.Status != OutboxQueued {
			continue
		}
		if item.BotID != bot.ID || item.ChatID != owner.ChatID || item.UserID != owner.UserID || item.PairingID != owner.PairingID {
			item.Status = OutboxFailed
			item.Error = pointer("The Telegram pairing changed")
			continue
		}
		unknown := false
		for _, prior := range gateway.config.Outbox {
			unknown = unknown || item.DeliveryID != "" && prior.DeliveryID == item.DeliveryID && prior.Status == OutboxUnknown
		}
		if unknown {
			item.Status = OutboxFailed
			item.Error = pointer("An earlier part of this reply was unconfirmed; remaining parts were not sent")
			continue
		}
		message := messageByID(state, item.LocalMessageID)
		role := mirrorRole(item, state)
		if item.LocalMessageID != "" && (gateway.suppress(message, item.Kind, item.AttachmentID) || gateway.config.ForwardMode == ForwardUnread && role == contracts.RoleUser) {
			if message != nil {
				marker := mirrorOf(message)
				marker.PairingID = owner.PairingID
				if item.Kind == "text" {
					marker.Text = mirrorStatus(MirrorSuppressed)
				} else {
					found := false
					for index := range marker.Files {
						if marker.Files[index].ID == item.AttachmentID {
							marker.Files[index].Status = MirrorSuppressed
							found = true
						}
					}
					if !found {
						marker.Files = append(marker.Files, mirrorFile{item.AttachmentID, MirrorSuppressed})
					}
				}
				if err := gateway.updateMirror(ctx, state.ConversationID, message.ID, marker); err != nil {
					return err
				}
			}
			item.Status, item.Error, item.FailureAt, item.FailureReason = OutboxSuppressed, nil, 0, ""
			continue
		}
		if role == contracts.RoleAssistant && item.LocalMessageID != "" && item.NotBefore == 0 {
			item.NotBefore = gateway.options.Now().Add(gateway.options.MirrorGrace).UnixMilli()
			item.MirrorRole = role
		}
	}
	return gateway.saveLocked(ctx)
}

func (gateway *Gateway) nextLocked() ([]*OutboxItem, int64) {
	now := gateway.options.Now().UnixMilli()
	wakeAt := int64(0)
	waiting := false
	state := gateway.options.Store.Snapshot()
	for index := 0; index < len(gateway.config.Outbox); index++ {
		first := gateway.config.Outbox[index]
		if first.Status != OutboxQueued {
			continue
		}
		if waiting && (first.LocalMessageID != "" || !strings.HasPrefix(first.ID, "command:") && !strings.HasPrefix(first.ID, "update:")) {
			continue
		}
		items := []*OutboxItem{first}
		length, readyAt := contracts.UTF16Length(first.Text), first.NotBefore
		if gateway.config.CombineReplies && first.Kind == "text" && mirrorRole(first, state) == contracts.RoleAssistant {
			for next := index + 1; next < len(gateway.config.Outbox); next++ {
				item := gateway.config.Outbox[next]
				if item.Status != OutboxQueued || item.Kind != "text" || mirrorRole(item, state) != contracts.RoleAssistant || item.PairingID != first.PairingID || length+2+contracts.UTF16Length(item.Text) > MaxTextUnits {
					break
				}
				items = append(items, item)
				length += 2 + contracts.UTF16Length(item.Text)
				readyAt = max(readyAt, item.NotBefore)
			}
			readyAt = min(readyAt, first.At+max(int64(10000), gateway.options.MirrorGrace.Milliseconds()))
		}
		if readyAt <= now {
			return items, 0
		}
		if wakeAt == 0 || readyAt < wakeAt {
			wakeAt = readyAt
		}
		waiting = true
		index += len(items) - 1
	}
	return nil, wakeAt
}

func (gateway *Gateway) silentLocked(items []*OutboxItem) bool {
	state := gateway.options.Store.Snapshot()
	for _, item := range items {
		if mirrorRole(item, state) != contracts.RoleAssistant {
			return false
		}
	}
	var previous *OutboxItem
	for _, item := range gateway.config.Outbox {
		if item == items[0] {
			break
		}
		if item.Status == OutboxSent {
			previous = item
		}
	}
	if previous == nil || mirrorRole(previous, state) != contracts.RoleAssistant {
		return false
	}
	at := previous.SentAt
	if at == 0 {
		at = previous.LastAttemptAt
	}
	if at == 0 {
		at = previous.At
	}
	now := gateway.options.Now().UnixMilli()
	if at <= 0 || now < at || now-at > 10000 {
		return false
	}
	if gateway.config.CombineReplies {
		return true
	}
	for _, item := range items {
		if item.DeliveryID == previous.DeliveryID {
			return true
		}
	}
	return false
}

// Flush sends only a persisted queued intent. Unknown outcomes are terminal;
// the only retries follow an explicit 429 rejection or rejected photo format.
func (gateway *Gateway) Flush(ctx context.Context) (int64, error) {
	if err := gateway.operation(ctx); err != nil {
		return 0, err
	}
	defer func() { <-gateway.operations }()
	for ctx.Err() == nil {
		gateway.mu.Lock()
		if !gateway.config.Enabled || gateway.config.Owner == nil || gateway.config.Token == nil {
			gateway.mu.Unlock()
			return 0, nil
		}
		if err := gateway.scanResultsLocked(ctx); err != nil {
			gateway.mu.Unlock()
			return 0, err
		}
		if err := gateway.prepareLocked(ctx); err != nil {
			gateway.mu.Unlock()
			return 0, err
		}
		items, wakeAt := gateway.nextLocked()
		if len(items) == 0 {
			gateway.mu.Unlock()
			return wakeAt, nil
		}
		silent := gateway.silentLocked(items)
		for _, item := range items {
			item.Status = OutboxSending
			item.Attempts++
			item.LastAttemptAt = gateway.options.Now().UnixMilli()
			item.NotificationSilent = silent
		}
		if err := gateway.saveLocked(ctx); err != nil {
			gateway.mu.Unlock()
			return 0, err
		}
		token := *gateway.config.Token
		gateway.mu.Unlock()
		gateway.changed()
		messageID, method, err := gateway.send(ctx, token, items, silent)
		gateway.mu.Lock()
		retryAfter := time.Duration(0)
		if err == nil {
			for _, item := range items {
				item.Status, item.SentAt, item.Error, item.FailureAt, item.FailureReason = OutboxSent, gateway.options.Now().UnixMilli(), nil, 0, ""
				item.TelegramMessageID = pointer(messageID)
			}
			gateway.config.LastOutboundAt = number(gateway.options.Now().UnixMilli())
		} else {
			var operation *OperationError
			if !errors.As(err, &operation) {
				operation = &OperationError{Reason: "attachment"}
			}
			if method == "sendPhoto" && operation.Code == 400 && !operation.Unknown && !items[0].DocumentFallback {
				items[0].DocumentFallback = true
				items[0].Status = OutboxQueued
				items[0].Error = pointer("Telegram rejected the photo format; sending the original file instead")
			} else if operation.Code == 429 && !operation.Unknown && operation.RetryAfter > 0 && operation.RetryAfter <= 300*time.Second {
				safe := true
				for _, item := range items {
					safe = safe && item.Attempts < 3
				}
				if safe {
					retryAfter = operation.RetryAfter
					for _, item := range items {
						item.Status = OutboxQueued
						item.Error = pointer("Telegram rate limit; waiting before a confirmed-safe retry")
					}
				}
			}
			for _, item := range items {
				if item.Status != OutboxSending {
					continue
				}
				item.Status = OutboxFailed
				if operation.Unknown {
					item.Status = OutboxUnknown
				}
				item.Error = pointer("Telegram request was not confirmed and was not resent")
				item.FailureAt = gateway.options.Now().UnixMilli()
				item.FailureReason = operation.Reason
				if !validReason(item.FailureReason) {
					item.FailureReason = "unconfirmed"
				}
				gateway.config.LastError = item.Error
			}
		}
		bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		saveErr := gateway.saveLocked(bounded)
		cancel()
		gateway.mu.Unlock()
		gateway.changed()
		if saveErr != nil {
			return 0, saveErr
		}
		if retryAfter > 0 && !wait(ctx, retryAfter) {
			return 0, ctx.Err()
		}
	}
	return 0, ctx.Err()
}
