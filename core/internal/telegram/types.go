// Package telegram owns Bot API pairing, durable receipts and bounded delivery.
// It requests work through caller-owned admission; it never owns an agent loop.
package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	MaxConfigBytes   = 1024 * 1024
	MaxOutbox        = 128
	MaxResponseBytes = 2 * 1024 * 1024
	MaxTextUnits     = 4096
	maxReceipts      = 1000
	apiOrigin        = "https://api.telegram.org"

	maxIncomingTextUnits      = 100000
	maxIncomingImageDimension = 100000
	maxIncomingQueue          = 32
	maxPhotoUploadBytes       = 10000000
	receiptWriteTimeout       = 5 * time.Second
)

var (
	ErrConfig   = errors.New("telegram_config_invalid")
	ErrClosed   = errors.New("telegram_gateway_closed")
	ErrDelivery = errors.New("telegram_delivery_unconfirmed")
	ErrIncoming = errors.New("telegram_input_not_accepted")
)

type OutboxStatus string

const (
	OutboxQueued     OutboxStatus = "queued"
	OutboxSending    OutboxStatus = "sending"
	OutboxSent       OutboxStatus = "sent"
	OutboxSuppressed OutboxStatus = "suppressed"
	OutboxFailed     OutboxStatus = "failed"
	OutboxUnknown    OutboxStatus = "unknown"
)

type ReceiptStatus string

const (
	ReceiptProcessing ReceiptStatus = "processing"
	ReceiptDone       ReceiptStatus = "done"
	ReceiptFailed     ReceiptStatus = "failed"
	ReceiptUnknown    ReceiptStatus = "unknown"
)

type ForwardMode string

const (
	ForwardUnread ForwardMode = "unread"
	ForwardAll    ForwardMode = "all"
)

type Bot struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}
type Owner struct {
	ChatID         string `json:"chatId"`
	UserID         string `json:"userId"`
	PairingID      string `json:"pairingId"`
	SyncVersion    int    `json:"syncVersion,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
}
type Pairing struct {
	Hash      string `json:"hash"`
	ExpiresAt int64  `json:"expiresAt"`
}
type Receipt struct {
	ID     int64         `json:"id"`
	Status ReceiptStatus `json:"status"`
	At     int64         `json:"at,omitempty"`
}

type OutboxItem struct {
	ID                 string         `json:"id"`
	Kind               string         `json:"kind"`
	Text               string         `json:"text,omitempty"`
	AttachmentID       string         `json:"attachmentId,omitempty"`
	DeliveryID         string         `json:"deliveryId,omitempty"`
	LocalMessageID     string         `json:"localMessageId,omitempty"`
	TaskID             string         `json:"taskId,omitempty"`
	MirrorRole         contracts.Role `json:"mirrorRole,omitempty"`
	Caption            string         `json:"caption,omitempty"`
	BotID              string         `json:"botId"`
	ChatID             string         `json:"chatId"`
	UserID             string         `json:"userId"`
	PairingID          string         `json:"pairingId,omitempty"`
	Status             OutboxStatus   `json:"status"`
	Attempts           int            `json:"attempts"`
	At                 int64          `json:"at"`
	Error              *string        `json:"error,omitempty"`
	FailureAt          int64          `json:"failureAt,omitempty"`
	FailureReason      string         `json:"failureReason,omitempty"`
	LastAttemptAt      int64          `json:"lastAttemptAt,omitempty"`
	NotBefore          int64          `json:"notBefore,omitempty"`
	SentAt             int64          `json:"sentAt,omitempty"`
	DocumentFallback   bool           `json:"documentFallback,omitempty"`
	NotificationSilent bool           `json:"notificationSilent,omitempty"`
	TelegramMessageID  *string        `json:"telegramMessageId,omitempty"`
	legacyText         json.RawMessage
	decodedText        string
}

type Config struct {
	Version         int           `json:"version"`
	DeliveryVersion int           `json:"deliveryVersion"`
	ForwardMode     ForwardMode   `json:"forwardMode"`
	CombineReplies  bool          `json:"combineReplies"`
	Enabled         bool          `json:"enabled"`
	Token           *string       `json:"token"`
	Bot             *Bot          `json:"bot"`
	Owner           *Owner        `json:"owner"`
	Offset          int64         `json:"offset"`
	Pairing         *Pairing      `json:"pairing"`
	Outbox          []*OutboxItem `json:"outbox"`
	Receipts        []Receipt     `json:"receipts"`
	ResultKeys      []string      `json:"resultKeys"`
	LastError       *string       `json:"lastError"`
	PollError       *string       `json:"pollError"`
	LastInboundAt   *int64        `json:"lastInboundAt"`
	LastOutboundAt  *int64        `json:"lastOutboundAt"`
}

type Persistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
	Add(context.Context, *contracts.ChatMessage) (*contracts.ChatMessage, error)
	Update(context.Context, string, contracts.MessagePatch) (*contracts.ChatMessage, error)
}

type Attachments interface {
	Read(context.Context, string) (contracts.Attachment, []byte, error)
	Put(context.Context, string, string, []byte) (contracts.Attachment, error)
}

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type WorkState struct {
	Online    bool
	Takeover  bool
	Acquiring bool
	Call      *contracts.Call
	Active    *contracts.ActiveExecution
	Queue     []string
	Pending   bool
}

type Options struct {
	Store                 Persistence
	Attachments           Attachments
	Admit                 func(context.Context, string, *contracts.ChatMessage) error
	ReportIncomingFailure func(IntakeFailureCode)
	WorkSnapshot          func() WorkState
	Pause                 func(context.Context) error
	Resume                func(context.Context, []string) error
	StopOwned             func(context.Context, Owner, Bot) (bool, error)
	Redact                func(string) string
	Changed               func()
	HTTP                  HTTPDoer
	Now                   func() time.Time
	Random                func([]byte) (int, error)
	AutoPoll              bool
	PollTimeout           time.Duration
	RetryBase             time.Duration
	MirrorGrace           time.Duration
}

type ConfigureInput struct {
	Token          *string      `json:"token,omitempty"`
	Enabled        *bool        `json:"enabled,omitempty"`
	ForwardMode    *ForwardMode `json:"forwardMode,omitempty"`
	CombineReplies *bool        `json:"combineReplies,omitempty"`
}

type PairResult struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
	BotURL    string `json:"botUrl"`
}

type File struct {
	ID     string `json:"file_id"`
	Size   *int64 `json:"file_size,omitempty"`
	Name   string `json:"file_name,omitempty"`
	Width  int64  `json:"width,omitempty"`
	Height int64  `json:"height,omitempty"`
}
type IncomingMessage struct {
	ID      json.RawMessage `json:"message_id"`
	Text    string          `json:"text,omitempty"`
	Caption string          `json:"caption,omitempty"`
	Chat    struct {
		ID   json.RawMessage `json:"id"`
		Type string          `json:"type"`
	} `json:"chat"`
	From struct {
		ID  json.RawMessage `json:"id"`
		Bot bool            `json:"is_bot"`
	} `json:"from"`
	Photo    []File `json:"photo,omitempty"`
	Voice    *File  `json:"voice,omitempty"`
	Document *File  `json:"document,omitempty"`
}
type Update struct {
	ID      int64            `json:"update_id"`
	Message *IncomingMessage `json:"message,omitempty"`
}

type OperationError struct {
	Code       int
	RetryAfter time.Duration
	Reason     string
	Unknown    bool
}

func (value *OperationError) Error() string            { return "telegram_request_failed" }
func (value *OperationError) UnconfirmedOutcome() bool { return value.Unknown }
