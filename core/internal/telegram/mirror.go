package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type MirrorStatus string

const (
	MirrorPending    MirrorStatus = "pending"
	MirrorScheduling MirrorStatus = "scheduling"
	MirrorScheduled  MirrorStatus = "scheduled"
	MirrorSuppressed MirrorStatus = "suppressed"
	MirrorUnknown    MirrorStatus = "unknown"
	MirrorHistorical MirrorStatus = "historical"
	MirrorFailed     MirrorStatus = "failed"
)

type mirrorFile struct {
	ID     string       `json:"id"`
	Status MirrorStatus `json:"status"`
}
type mirrorMarker struct {
	PairingID  string        `json:"pairingId"`
	Historical bool          `json:"historical,omitempty"`
	Text       *MirrorStatus `json:"text,omitempty"`
	Files      []mirrorFile  `json:"files,omitempty"`
}
type deliveryMarker struct {
	Key            string       `json:"key"`
	PairingID      string       `json:"pairingId"`
	ReplyThroughID *string      `json:"replyThroughId"`
	ScheduledAt    int64        `json:"scheduledAt"`
	Status         MirrorStatus `json:"status"`
}

func mirrorOf(message *contracts.ChatMessage) mirrorMarker {
	var marker mirrorMarker
	data := raw(message.TelegramMirror)
	_ = json.Unmarshal(data, &marker)
	return marker
}
func deliveryOf(message *contracts.ChatMessage) deliveryMarker {
	var marker deliveryMarker
	_ = json.Unmarshal(raw(message.TelegramDelivery), &marker)
	return marker
}
func mirrorStatus(value MirrorStatus) *MirrorStatus { return &value }
func statusOf(message *contracts.ChatMessage) contracts.MessageStatus {
	value, _ := message.Status.Get()
	return value
}

func taskIDOf(message *contracts.ChatMessage) string {
	value, _ := message.TaskID.Get()
	return value
}
func terminal(status contracts.MessageStatus) bool {
	return status == contracts.MessageStatus(contracts.TaskStatusReview) || status == contracts.MessageStatus(contracts.TaskStatusCompleted) || status == contracts.MessageStatus(contracts.TaskStatusFailed) || status == contracts.MessageStatus(contracts.TaskStatusPaused)
}
func (gateway *Gateway) taskOwned(message *contracts.ChatMessage) bool {
	owner, bot := gateway.config.Owner, gateway.config.Bot
	return message != nil && owner != nil && bot != nil && field(message.Source, "type") == "telegram" && field(message.Source, "pairingId") == owner.PairingID && field(message.Source, "botId") == bot.ID && field(message.Source, "chatId") == owner.ChatID && field(message.Source, "userId") == owner.UserID
}
func resultKey(message *contracts.ChatMessage, pairingID string) string {
	turn, _ := message.TurnID.Get()
	if turn == "" {
		turn = "unsubmitted"
	}
	status := string(statusOf(message))
	if status == string(contracts.TaskStatusReview) || status == string(contracts.TaskStatusCompleted) {
		status = "result"
	}
	return fmt.Sprintf("result:%s:%s:%s:%s", pairingID, message.ID, turn, status)
}

func (gateway *Gateway) baselineLocked(ctx context.Context) error {
	owner := gateway.config.Owner
	state := gateway.options.Store.Snapshot()
	if owner == nil || owner.SyncVersion == 1 && owner.ConversationID == state.ConversationID {
		return nil
	}
	err := gateway.options.Store.Mutate(ctx, func(latest *contracts.State) error {
		if latest.ConversationID != state.ConversationID {
			return ErrIncoming
		}
		replies := map[string]string{}
		for _, message := range latest.Messages {
			if message != nil && message.Role == contracts.RoleAssistant && statusOf(message) == contracts.MessageStatus(contracts.TaskStatusCompleted) && taskIDOf(message) != "" {
				replies[taskIDOf(message)] = message.ID
			}
		}
		for _, message := range latest.Messages {
			if message == nil {
				continue
			}
			message.TelegramMirror = object(mirrorMarker{PairingID: owner.PairingID, Historical: true})
			if message.Role == contracts.RoleUser && gateway.taskOwned(message) && terminal(statusOf(message)) {
				key := resultKey(message, owner.PairingID)
				if deliveryOf(message).Key != key {
					var reply *string
					if replies[message.ID] != "" {
						reply = pointer(replies[message.ID])
					}
					message.TelegramDelivery = object(deliveryMarker{key, owner.PairingID, reply, gateway.options.Now().UnixMilli(), MirrorHistorical})
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	owner.SyncVersion, owner.ConversationID = 1, state.ConversationID
	return nil
}

func (gateway *Gateway) updateMirror(ctx context.Context, conversation, id string, marker mirrorMarker) error {
	return gateway.options.Store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversation {
			return ErrIncoming
		}
		for _, message := range state.Messages {
			if message != nil && message.ID == id {
				message.TelegramMirror = object(marker)
				return nil
			}
		}
		return ErrIncoming
	})
}

func (gateway *Gateway) updateDelivery(ctx context.Context, conversation, id string, marker deliveryMarker) error {
	return gateway.options.Store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversation {
			return ErrIncoming
		}
		for _, message := range state.Messages {
			if message != nil && message.ID == id {
				message.TelegramDelivery = object(marker)
				return nil
			}
		}
		return ErrIncoming
	})
}

func (gateway *Gateway) queueBatchLocked(ctx context.Context, items []*OutboxItem) (bool, error) {
	owner, bot := gateway.config.Owner, gateway.config.Bot
	if owner == nil || bot == nil {
		return false, nil
	}
	previous := append([]*OutboxItem{}, gateway.config.Outbox...)
	next := append([]*OutboxItem{}, previous...)
	for _, item := range items {
		found := false
		for _, prior := range next {
			if prior.ID == item.ID {
				found = true
				break
			}
		}
		if found {
			continue
		}
		for len(next) >= MaxOutbox {
			index := slices.IndexFunc(next, func(prior *OutboxItem) bool { return prior.Status == OutboxSent || prior.Status == OutboxSuppressed })
			if index < 0 {
				gateway.config.LastError = pointer("Telegram delivery queue is full; new chat messages are waiting")
				return false, nil
			}
			next = slices.Delete(next, index, index+1)
		}
		copy := *item
		copy.BotID, copy.ChatID, copy.UserID, copy.PairingID = bot.ID, owner.ChatID, owner.UserID, owner.PairingID
		copy.Status, copy.At = OutboxQueued, gateway.options.Now().UnixMilli()
		if copy.MirrorRole == contracts.RoleAssistant {
			copy.NotBefore = gateway.options.Now().Add(gateway.options.MirrorGrace).UnixMilli()
		}
		next = append(next, &copy)
	}
	gateway.config.Outbox = next
	if data, err := json.Marshal(gateway.config); err != nil || len(data) > MaxConfigBytes-256*1024 {
		gateway.config.Outbox = previous
		gateway.config.LastError = pointer("Telegram delivery queue reached its byte limit; new chat messages are waiting")
		return false, nil
	}
	if err := gateway.saveLocked(ctx); err != nil {
		gateway.config.Outbox = previous
		return false, err
	}
	return true, nil
}

func (gateway *Gateway) queueTextLocked(ctx context.Context, id, text string, extra OutboxItem) (bool, error) {
	items := []*OutboxItem{}
	for index, chunk := range SplitText(gateway.safeText(text)) {
		item := extra
		item.ID = fmt.Sprintf("%s:%d", id, index)
		item.Kind, item.Text = "text", chunk
		items = append(items, &item)
	}
	return gateway.queueBatchLocked(ctx, items)
}

func (gateway *Gateway) suppress(message *contracts.ChatMessage, kind, attachmentID string) bool {
	if message == nil {
		return false
	}
	marker := mirrorOf(message)
	if marker.PairingID == gateway.config.Owner.PairingID {
		if kind == "text" && marker.Text != nil && *marker.Text == MirrorSuppressed {
			return true
		}
		for _, file := range marker.Files {
			if kind != "text" && file.ID == attachmentID && file.Status == MirrorSuppressed {
				return true
			}
		}
	}
	if gateway.config.ForwardMode != ForwardUnread {
		return false
	}
	if message.Role == contracts.RoleUser {
		return true
	}
	if message.Role != contracts.RoleAssistant {
		return false
	}
	if kind == "text" {
		return message.Read
	}
	return slices.Contains(message.VisibleAttachmentIDs, attachmentID)
}

func (gateway *Gateway) scanMirrorsLocked(ctx context.Context) error {
	state := gateway.options.Store.Snapshot()
	owner := gateway.config.Owner
	tasks := map[string]*contracts.ChatMessage{}
	for _, message := range state.Messages {
		if message != nil && message.Role == contracts.RoleUser {
			tasks[message.ID] = message
		}
	}
	for _, message := range state.Messages {
		if message == nil || message.Role != contracts.RoleUser && message.Role != contracts.RoleAssistant || message.Kind == "call" || message.Role == contracts.RoleAssistant && statusOf(message) != contracts.MessageStatus(contracts.TaskStatusCompleted) || message.Role == contracts.RoleUser && field(message.Source, "type") == "telegram" {
			continue
		}
		task := tasks[taskIDOf(message)]
		voiceDelivery := field(message.Source, "type") == "voice-call" && field(message.Source, "conversationId") == state.ConversationID
		if message.Role == contracts.RoleAssistant && (taskIDOf(message) != "" && task == nil && !voiceDelivery || task != nil && field(task.Source, "type") == "telegram" && !gateway.taskOwned(task)) {
			continue
		}
		marker := mirrorOf(message)
		if marker.Historical || marker.PairingID != "" && marker.PairingID != owner.PairingID {
			continue
		}
		marker.PairingID = owner.PairingID
		group := "mirror:" + owner.PairingID + ":" + message.ID
		interrupted := marker.Text != nil && *marker.Text == MirrorScheduling
		for _, file := range marker.Files {
			interrupted = interrupted || file.Status == MirrorScheduling
		}
		if interrupted {
			if marker.Text != nil && *marker.Text == MirrorScheduling {
				marker.Text = mirrorStatus(MirrorUnknown)
			}
			for index := range marker.Files {
				if marker.Files[index].Status == MirrorScheduling {
					marker.Files[index].Status = MirrorUnknown
				}
			}
			if err := gateway.updateMirror(ctx, state.ConversationID, message.ID, marker); err != nil {
				return err
			}
			for _, item := range gateway.config.Outbox {
				if item.DeliveryID == group && item.Status == OutboxQueued {
					item.Status = OutboxFailed
					item.Error = pointer("Chat mirror scheduling was interrupted; it was not repeated")
				}
			}
			gateway.config.LastError = pointer("Telegram chat mirror scheduling was interrupted; check delivery before resending")
			if err := gateway.saveLocked(ctx); err != nil {
				return err
			}
			continue
		}
		unknown := marker.Text != nil && *marker.Text == MirrorUnknown
		for _, file := range marker.Files {
			unknown = unknown || file.Status == MirrorUnknown
		}
		for _, item := range gateway.config.Outbox {
			unknown = unknown || item.DeliveryID == group && item.Status == OutboxUnknown
		}
		if unknown {
			continue
		}
		newText := message.Text != "" && marker.Text == nil || marker.Text != nil && *marker.Text == MirrorPending
		pendingFiles := []contracts.Attachment{}
		for _, attachment := range message.Attachments[:min(len(message.Attachments), 5)] {
			seen := false
			for _, prior := range marker.Files {
				if prior.ID == attachment.ID && prior.Status != MirrorPending {
					seen = true
				}
			}
			if !seen {
				pendingFiles = append(pendingFiles, attachment)
			}
		}
		if newText && gateway.suppress(message, "text", "") {
			marker.Text = mirrorStatus(MirrorSuppressed)
			newText = false
		}
		items := []*OutboxItem{}
		if newText {
			encoded := raw(message)
			textObject, err := contracts.DecodeObject(encoded, len(encoded))
			if err != nil {
				return ErrIncoming
			}
			desktop := ""
			if message.Role == contracts.RoleUser {
				desktop = gateway.word("desktop")
			}
			token := ""
			if gateway.config.Token != nil {
				token = *gateway.config.Token
			}
			units, err := mirrorUnits(textObject["text"], desktop, token)
			if err != nil {
				return err
			}
			for index, chunk := range splitUnits(units) {
				text := string(utf16.Decode(chunk))
				items = append(items, &OutboxItem{ID: fmt.Sprintf("%s:text:%d", group, index), Kind: "text", Text: text, DeliveryID: group, LocalMessageID: message.ID, MirrorRole: message.Role, legacyText: contracts.EncodeJSONTextUnits(chunk), decodedText: text})
			}
			marker.Text = mirrorStatus(MirrorScheduling)
		}
		for _, attachment := range pendingFiles {
			status := MirrorScheduling
			if gateway.suppress(message, "document", attachment.ID) {
				status = MirrorSuppressed
			} else {
				item := &OutboxItem{ID: group + ":file:" + attachment.ID, Kind: "document", AttachmentID: attachment.ID, DeliveryID: group, LocalMessageID: message.ID, MirrorRole: message.Role}
				if message.Role == contracts.RoleUser {
					item.Caption = gateway.word("desktop")
				}
				items = append(items, item)
			}
			found := false
			for index := range marker.Files {
				if marker.Files[index].ID == attachment.ID {
					marker.Files[index].Status = status
					found = true
				}
			}
			if !found {
				marker.Files = append(marker.Files, mirrorFile{attachment.ID, status})
			}
		}
		if rawMarker := raw(marker); string(rawMarker) == string(raw(mirrorOf(message))) {
			continue
		}
		if err := gateway.updateMirror(ctx, state.ConversationID, message.ID, marker); err != nil {
			return err
		}
		if len(items) == 0 {
			continue
		}
		accepted, err := gateway.queueBatchLocked(ctx, items)
		if err != nil {
			return err
		}
		status := MirrorPending
		if accepted {
			status = MirrorScheduled
		}
		if newText {
			marker.Text = mirrorStatus(status)
		}
		for index := range marker.Files {
			if marker.Files[index].Status == MirrorScheduling {
				marker.Files[index].Status = status
			}
		}
		if err = gateway.updateMirror(ctx, state.ConversationID, message.ID, marker); err != nil {
			return err
		}
	}
	return nil
}

func (gateway *Gateway) scanResultsLocked(ctx context.Context) error {
	if !gateway.config.Enabled || gateway.config.Owner == nil {
		return nil
	}
	if err := gateway.baselineLocked(ctx); err != nil {
		return err
	}
	if err := gateway.saveLocked(ctx); err != nil {
		return err
	}
	if err := gateway.scanMirrorsLocked(ctx); err != nil {
		return err
	}
	state := gateway.options.Store.Snapshot()
	for _, task := range state.Messages {
		if task == nil || task.Role != contracts.RoleUser || !gateway.taskOwned(task) || !terminal(statusOf(task)) {
			continue
		}
		success := statusOf(task) == contracts.MessageStatus(contracts.TaskStatusReview) || statusOf(task) == contracts.MessageStatus(contracts.TaskStatusCompleted)
		turn, _ := task.TurnID.Get()
		unfinished := false
		if success {
			for _, record := range state.WorkTasks {
				messageID, _ := record.MessageID.Get()
				if messageID != task.ID && (turn == "" || record.TurnID != turn && !slices.Contains(record.TurnIDs, turn)) {
					continue
				}
				done := record.Status == contracts.WorkStatusCompleted
				if record.Status == contracts.WorkStatusReview && record.Plan != nil && len(record.Plan.Steps) > 0 {
					done = true
					for _, step := range record.Plan.Steps {
						done = done && step.Status == contracts.PlanStepStatusCompleted
					}
				}
				unfinished = unfinished || !done
			}
		}
		if unfinished {
			continue
		}
		key := resultKey(task, gateway.config.Owner.PairingID)
		previous := deliveryOf(task)
		if previous.Key == key {
			if previous.Status == MirrorScheduling {
				previous.Status = MirrorUnknown
				if err := gateway.updateDelivery(ctx, state.ConversationID, task.ID, previous); err != nil {
					return err
				}
			}
			continue
		}
		replies := []*contracts.ChatMessage{}
		for _, message := range state.Messages {
			if message != nil && message.Role == contracts.RoleAssistant && taskIDOf(message) == task.ID && statusOf(message) == contracts.MessageStatus(contracts.TaskStatusCompleted) {
				replies = append(replies, message)
			}
		}
		var through *string
		if len(replies) > 0 {
			through = pointer(replies[len(replies)-1].ID)
		}
		marker := deliveryMarker{key, gateway.config.Owner.PairingID, through, gateway.options.Now().UnixMilli(), MirrorScheduling}
		legacy := "result:" + key[len("result:"+gateway.config.Owner.PairingID+":"):]
		if slices.Contains(gateway.config.ResultKeys, key) || slices.Contains(gateway.config.ResultKeys, legacy) {
			marker.Status = MirrorScheduled
			if err := gateway.updateDelivery(ctx, state.ConversationID, task.ID, marker); err != nil {
				return err
			}
			continue
		}
		if previous.PairingID == marker.PairingID && previous.ReplyThroughID != nil {
			anchor := slices.IndexFunc(replies, func(reply *contracts.ChatMessage) bool { return reply.ID == *previous.ReplyThroughID })
			if anchor < 0 {
				replies = nil
			} else {
				replies = replies[anchor+1:]
			}
		}
		if err := gateway.updateDelivery(ctx, state.ConversationID, task.ID, marker); err != nil {
			return err
		}
		text := ""
		if success {
			delivered := false
			for _, reply := range replies {
				delivered = delivered || reply.Text != "" || len(reply.Attachments) > 0
			}
			if !delivered {
				text = gateway.word("workFinished")
			}
		} else {
			submission, _ := task.Submission.Get()
			if submission == contracts.SubmissionStatusUnknown {
				text = gateway.word("submissionUnknown")
			} else if statusOf(task) == contracts.MessageStatus(contracts.TaskStatusPaused) {
				text = gateway.word("taskPaused")
			} else {
				text = gateway.word("taskFailed")
			}
		}
		accepted := true
		if text != "" {
			var err error
			accepted, err = gateway.queueTextLocked(ctx, key, text, OutboxItem{DeliveryID: key, TaskID: task.ID})
			if err != nil {
				return err
			}
		}
		marker.Status = MirrorFailed
		if accepted {
			marker.Status = MirrorScheduled
		}
		if err := gateway.updateDelivery(ctx, state.ConversationID, task.ID, marker); err != nil {
			return err
		}
	}
	return nil
}

func (gateway *Gateway) Scan(ctx context.Context) error {
	if err := gateway.operation(ctx); err != nil {
		return err
	}
	defer func() { <-gateway.operations }()
	gateway.mu.Lock()
	err := gateway.scanResultsLocked(ctx)
	gateway.mu.Unlock()
	gateway.Wake()
	return err
}
