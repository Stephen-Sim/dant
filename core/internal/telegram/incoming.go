package telegram

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
)

var commandPattern = regexp.MustCompile(`(?i)^/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([^\n]*))?$`)
var remotePathPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_.-]+)*$`)

func (gateway *Gateway) Receive(ctx context.Context, update Update) error {
	if err := gateway.operation(ctx); err != nil {
		return err
	}
	defer func() { <-gateway.operations }()
	gateway.mu.Lock()
	config := &gateway.config
	if !config.Enabled || config.Bot == nil || update.ID < config.Offset || update.ID < 0 || update.ID >= 9007199254740991 {
		gateway.mu.Unlock()
		return nil
	}
	finishIgnored := func() error {
		config.Offset = max(config.Offset, update.ID+1)
		err := gateway.saveLocked(ctx)
		gateway.mu.Unlock()
		return err
	}
	for _, receipt := range config.Receipts {
		if receipt.ID == update.ID {
			return finishIgnored()
		}
	}
	message := update.Message
	if message == nil || message.Chat.Type != "private" || identifier(message.Chat.ID) == "" || identifier(message.From.ID) == "" || message.From.Bot {
		return finishIgnored()
	}
	match := commandPattern.FindStringSubmatch(message.Text)
	command, args := "", ""
	if len(match) > 0 {
		command, args = strings.ToLower(match[1]), contracts.TrimText(match[2])
	}
	if config.Owner == nil {
		pairing := config.Pairing
		if command != "start" || pairing == nil || pairing.ExpiresAt <= gateway.options.Now().UnixMilli() || !pairingPattern.MatchString(args) || !hashPattern.MatchString(pairing.Hash) {
			return finishIgnored()
		}
		actual, _ := hex.DecodeString(digest(args))
		expected, _ := hex.DecodeString(pairing.Hash)
		if subtle.ConstantTimeCompare(actual, expected) != 1 {
			return finishIgnored()
		}
		identity := make([]byte, 16)
		if count, err := gateway.options.Random(identity); err != nil || count != len(identity) {
			gateway.mu.Unlock()
			return ErrConfig
		}
		config.Owner = &Owner{ChatID: identifier(message.Chat.ID), UserID: identifier(message.From.ID), PairingID: hex.EncodeToString(identity)}
		if err := gateway.baselineLocked(ctx); err != nil {
			gateway.mu.Unlock()
			return err
		}
		config.Pairing = nil
		if err := gateway.saveLocked(ctx); err != nil {
			gateway.mu.Unlock()
			return err
		}
	}
	owner, bot := *config.Owner, *config.Bot
	if owner.ChatID != identifier(message.Chat.ID) || owner.UserID != identifier(message.From.ID) {
		return finishIgnored()
	}
	config.Receipts = append(config.Receipts, Receipt{update.ID, ReceiptProcessing, gateway.options.Now().UnixMilli()})
	if len(config.Receipts) > maxReceipts {
		config.Receipts = config.Receipts[len(config.Receipts)-maxReceipts:]
	}
	config.LastInboundAt = number(gateway.options.Now().UnixMilli())
	if err := gateway.saveLocked(ctx); err != nil {
		gateway.mu.Unlock()
		return err
	}
	gateway.mu.Unlock()
	var err error
	if command != "" {
		err = gateway.command(ctx, command, update.ID, args, owner, bot)
	} else {
		err = gateway.incoming(ctx, message, update.ID, owner, bot)
	}
	gateway.mu.Lock()
	for index := range config.Receipts {
		if config.Receipts[index].ID == update.ID {
			config.Receipts[index].Status = ReceiptDone
			if err != nil {
				config.Receipts[index].Status = ReceiptFailed
			}
		}
	}
	if err != nil {
		config.LastError = pointer("A Telegram message could not be accepted; it was not replayed")
		clientID := fmt.Sprintf("tg:%s:%d", bot.ID, update.ID)
		found := false
		for _, task := range gateway.options.Store.Snapshot().Messages {
			if task != nil && task.ClientMessageID == clientID {
				found = true
			}
		}
		if !found {
			_, _ = gateway.queueTextLocked(ctx, fmt.Sprintf("update:%d:error", update.ID), gateway.word("receiveError"), OutboxItem{})
		}
	}
	config.Offset = max(config.Offset, update.ID+1)
	saveErr := gateway.saveLocked(ctx)
	gateway.mu.Unlock()
	gateway.changed()
	gateway.Wake()
	return saveErr
}

type incomingCandidate struct {
	file     File
	name     string
	typeName string
}

func (gateway *Gateway) incoming(ctx context.Context, message *IncomingMessage, updateID int64, owner Owner, bot Bot) error {
	state := gateway.options.Store.Snapshot()
	conversation := state.ConversationID
	clientID := fmt.Sprintf("tg:%s:%d", bot.ID, updateID)
	for _, task := range state.Messages {
		if task != nil && task.ClientMessageID == clientID {
			return nil
		}
	}
	if slices.Contains(state.DeletedClientMessageIDs, clientID) {
		return ErrIncoming
	}
	text := message.Text
	if text == "" {
		text = message.Caption
	}
	gateway.mu.Lock()
	text = gateway.safeText(text)
	gateway.mu.Unlock()
	if contracts.UTF16Length(text) > maxIncomingTextUnits {
		return ErrIncoming
	}
	candidates := []incomingCandidate{}
	if len(message.Photo) > 0 {
		photos := append([]File{}, message.Photo...)
		sort.SliceStable(photos, func(a, b int) bool {
			score := func(file File) int64 {
				if file.Size != nil {
					return *file.Size
				}
				if file.Width < 0 || file.Width > maxIncomingImageDimension || file.Height < 0 || file.Height > maxIncomingImageDimension {
					return 0
				}
				return file.Width * file.Height
			}
			return score(photos[a]) > score(photos[b])
		})
		found := false
		for _, photo := range photos {
			if photo.Size == nil || *photo.Size <= files.MaxAttachmentBytes {
				candidates = append(candidates, incomingCandidate{photo, fmt.Sprintf("photo-%d.jpg", updateID), "image/jpeg"})
				found = true
				break
			}
		}
		if !found {
			return ErrIncoming
		}
	}
	if message.Document != nil {
		name := message.Document.Name
		if name == "" {
			name = "document"
		}
		candidates = append(candidates, incomingCandidate{*message.Document, name, ""})
	}
	if message.Voice != nil {
		name := message.Voice.Name
		if name == "" {
			name = fmt.Sprintf("voice-%d.ogg", updateID)
		}
		candidates = append(candidates, incomingCandidate{*message.Voice, name, "audio/ogg"})
	}
	if contracts.TrimText(text) == "" && len(candidates) == 0 {
		return nil
	}
	if len(candidates) > files.MaxMessageAttachments {
		return ErrIncoming
	}
	if text == "" && message.Voice == nil {
		text = gateway.word("attachmentPrompt")
	}
	source := object(map[string]any{"type": "telegram", "botId": bot.ID, "chatId": owner.ChatID, "userId": owner.UserID, "pairingId": owner.PairingID, "updateId": updateID})
	if messageID := identifier(message.ID); messageID != "" {
		source["messageId"] = raw(messageID)
	}
	task := &contracts.ChatMessage{
		ID:              uuid.NewString(),
		Role:            contracts.RoleUser,
		Text:            text,
		Time:            contracts.Some(float64(gateway.options.Now().UnixMilli())),
		Attachments:     []contracts.Attachment{},
		Reactions:       []string{},
		ClientMessageID: clientID,
		Status:          contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft)),
		Source:          source,
	}
	if err := gateway.options.Store.Mutate(ctx, func(latest *contracts.State) error {
		if latest.ConversationID != conversation {
			return ErrIncoming
		}
		for _, saved := range latest.Messages {
			if saved != nil && saved.ClientMessageID == clientID {
				return ErrIncoming
			}
		}
		latest.Messages = append(latest.Messages, task)
		return nil
	}); err != nil {
		gateway.intakeFailure(ctx, err, IntakePersistenceFailed)
		return err
	}
	attachments := []contracts.Attachment{}
	var err error
	failure := IntakeQueueFull
	if len(gateway.options.WorkSnapshot().Queue) >= maxIncomingQueue {
		err = ErrIncoming
	}
	for _, candidate := range candidates {
		if err != nil {
			break
		}
		var attachment contracts.Attachment
		failure = IntakeAttachmentFailed
		attachment, err = gateway.download(ctx, candidate)
		attachments = append(attachments, attachment)
	}
	if err == nil {
		failure = IntakePersistenceFailed
		err = gateway.options.Store.Mutate(ctx, func(latest *contracts.State) error {
			if latest.ConversationID != conversation {
				return ErrIncoming
			}
			for _, saved := range latest.Messages {
				if saved != nil && saved.ID == task.ID {
					saved.Attachments = attachments
					saved.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))
					*task = *saved
					return nil
				}
			}
			return ErrIncoming
		})
	}
	if err == nil {
		failure = IntakeAdmissionRejected
		if gateway.ctx.Err() != nil {
			err = ErrClosed
		} else {
			err = gateway.options.Admit(ctx, conversation, task)
		}
	}
	if err != nil {
		failure = gateway.intakeFailure(ctx, err, failure)
		message := gateway.intakeFailureText(failure)
		bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), receiptWriteTimeout)
		defer cancel()
		_ = gateway.options.Store.Mutate(bounded, func(latest *contracts.State) error {
			if latest.ConversationID != conversation {
				return nil
			}
			for _, saved := range latest.Messages {
				if saved == nil || saved.ID != task.ID {
					continue
				}
				submission, _ := saved.Submission.Get()
				if saved.UnknownOutcome || submission == contracts.SubmissionStatusUnknown || submission == contracts.SubmissionStatusSubmitting || submission == contracts.SubmissionStatusConfirmed {
					return nil
				}
				saved.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusFailed))
				saved.Error = contracts.Some(message)
			}
			return nil
		})
		return ErrIncoming
	}
	return nil
}

func (gateway *Gateway) download(ctx context.Context, candidate incomingCandidate) (contracts.Attachment, error) {
	file := candidate.file
	if file.ID == "" || len(file.ID) > 1024 || file.Size != nil && (*file.Size < 0 || *file.Size > files.MaxAttachmentBytes) {
		return contracts.Attachment{}, ErrIncoming
	}
	gateway.mu.Lock()
	token := ""
	if gateway.config.Token != nil {
		token = *gateway.config.Token
	}
	gateway.mu.Unlock()
	data, err := gateway.api(ctx, token, "getFile", raw(map[string]string{"file_id": file.ID}), "")
	if err != nil {
		return contracts.Attachment{}, err
	}
	info, err := contracts.DecodeObject(data, MaxResponseBytes)
	remote := field(info, "file_path")
	if err != nil || len(remote) > 2048 || !remotePathPattern.MatchString(remote) {
		return contracts.Attachment{}, ErrIncoming
	}
	for _, part := range strings.Split(remote, "/") {
		if part == "." || part == ".." {
			return contracts.Attachment{}, ErrIncoming
		}
	}
	if supplied, ok := info["file_size"]; ok {
		var size int64
		if json.Unmarshal(supplied, &size) != nil || size < 0 || size > files.MaxAttachmentBytes {
			return contracts.Attachment{}, ErrIncoming
		}
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(gateway.ctx, cancel)
	defer stop()
	request, err := http.NewRequestWithContext(bounded, http.MethodGet, apiOrigin+"/file/bot"+token+"/"+remote, nil)
	if err != nil {
		return contracts.Attachment{}, ErrIncoming
	}
	response, err := gateway.options.HTTP.Do(request)
	if err != nil {
		return contracts.Attachment{}, ErrIncoming
	}
	if response == nil {
		return contracts.Attachment{}, ErrIncoming
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.Body != nil {
			response.Body.Close()
		}
		return contracts.Attachment{}, ErrIncoming
	}
	data, err = responseBytes(response, files.MaxAttachmentBytes)
	if err != nil {
		return contracts.Attachment{}, ErrIncoming
	}
	return gateway.options.Attachments.Put(ctx, candidate.name, candidate.typeName, data)
}
