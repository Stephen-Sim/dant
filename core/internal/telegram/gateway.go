package telegram

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type Gateway struct {
	mu         sync.Mutex
	admin      chan struct{}
	operations chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	directory  string
	file       string
	identity   fs.FileInfo
	config     Config
	options    Options
	closed     bool
	connected  bool
	loopCancel context.CancelFunc
	loopDone   chan struct{}
	wake       chan struct{}
}

func Open(ctx context.Context, dataDir string, options Options) (*Gateway, error) {
	if options.Store == nil || options.Attachments == nil || options.Admit == nil || options.WorkSnapshot == nil {
		return nil, ErrConfig
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Read
	}
	if options.Redact == nil {
		options.Redact = func(text string) string { return text }
	}
	if options.PollTimeout == 0 {
		options.PollTimeout = 25 * time.Second
	}
	if options.RetryBase == 0 {
		options.RetryBase = time.Second
	}
	if options.MirrorGrace == 0 {
		options.MirrorGrace = 2500 * time.Millisecond
	}
	if options.PollTimeout < time.Second || options.PollTimeout > 50*time.Second || options.RetryBase < time.Millisecond || options.RetryBase > 30*time.Second || options.MirrorGrace < 0 || options.MirrorGrace > 30*time.Second {
		return nil, ErrConfig
	}
	if options.HTTP == nil {
		options.HTTP = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	directory, identity, config, changed, err := readConfig(dataDir)
	if err != nil {
		return nil, err
	}
	owned, cancel := context.WithCancel(ctx)
	gateway := &Gateway{
		ctx: owned, cancel: cancel,
		directory: directory,
		file:      filepath.Join(directory, "telegram.json"),
		identity:  identity,
		config:    config,
		options:   options,

		admin:      make(chan struct{}, 1),
		operations: make(chan struct{}, 1),
		wake:       make(chan struct{}, 1),
	}
	if changed {
		if err = gateway.saveLocked(ctx); err != nil {
			cancel()
			return nil, err
		}
	}
	return gateway, nil
}

func acquire(ctx context.Context, gate chan struct{}) error {
	select {
	case gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (gateway *Gateway) operation(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := acquire(ctx, gateway.operations); err != nil {
		return err
	}
	gateway.mu.Lock()
	closed := gateway.closed
	gateway.mu.Unlock()
	if closed || ctx.Err() != nil || gateway.ctx.Err() != nil {
		<-gateway.operations
		return ErrClosed
	}
	return nil
}

func (gateway *Gateway) changed() {
	if gateway.options.Changed != nil {
		gateway.options.Changed()
	}
}
func (gateway *Gateway) Wake() {
	select {
	case gateway.wake <- struct{}{}:
	default:
	}
}
func (gateway *Gateway) safeText(text string) string {
	if gateway.config.Token != nil {
		text = strings.ReplaceAll(text, *gateway.config.Token, "[redacted]")
	}
	return text
}

func (gateway *Gateway) Status() contracts.RawObject {
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	config := &gateway.config
	failed, unknown, pending := 0, 0, 0
	var latest *OutboxItem
	deliveryError := false
	for _, item := range config.Outbox {
		switch item.Status {
		case OutboxFailed:
			failed++
		case OutboxUnknown:
			unknown++
		case OutboxQueued, OutboxSending:
			pending++
		}
		if item.Status == OutboxFailed || item.Status == OutboxUnknown {
			if latest == nil || issueAt(item) >= issueAt(latest) {
				latest = item
			}
			if item.Error != nil && config.LastError != nil && *item.Error == *config.LastError {
				deliveryError = true
			}
		}
	}
	var issue any
	if latest != nil {
		reason := latest.FailureReason
		if !validReason(reason) {
			if latest.Status == OutboxUnknown {
				reason = "unconfirmed"
			} else {
				reason = "rejected"
			}
		}
		issue = map[string]any{"status": latest.Status, "at": issueAt(latest), "reason": reason}
	}
	safeError := func(value *string) any {
		if value == nil {
			return nil
		}
		return clip(gateway.safeText(*value), 500)
	}
	var owner any
	if config.Owner != nil {
		owner = map[string]string{"chatId": config.Owner.ChatID, "userId": config.Owner.UserID}
	}
	var pairing any
	if config.Pairing != nil && config.Pairing.ExpiresAt > gateway.options.Now().UnixMilli() {
		pairing = map[string]int64{"expiresAt": config.Pairing.ExpiresAt}
	}
	var connectionError *string
	if config.Enabled && !gateway.connected {
		connectionError = config.PollError
		if connectionError == nil && !deliveryError {
			connectionError = config.LastError
		}
	}
	return object(map[string]any{
		"enabled": config.Enabled, "configured": config.Token != nil && *config.Token != "", "connected": gateway.connected,
		"bot": config.Bot, "paired": config.Owner != nil, "owner": owner, "pairing": pairing,
		"lastError": safeError(config.LastError), "connectionError": safeError(connectionError), "lastInboundAt": config.LastInboundAt, "lastOutboundAt": config.LastOutboundAt,
		"pendingOutbound": pending, "delivery": map[string]any{"failed": failed, "unknown": unknown, "lastIssue": issue},
		"sync": map[string]any{"mode": "new-messages", "forwardMode": config.ForwardMode, "combineReplies": config.CombineReplies, "readState": "independent", "active": config.Enabled && config.Owner != nil && config.Owner.SyncVersion == 1, "historyBackfill": false, "edits": false, "deletes": false, "reactions": false},
	})
}

func issueAt(item *OutboxItem) int64 {
	if item.FailureAt > 0 {
		return item.FailureAt
	}
	if item.LastAttemptAt > 0 {
		return item.LastAttemptAt
	}
	return item.At
}
func validReason(reason string) bool {
	switch reason {
	case "timeout", "network", "dns", "tls", "cancelled", "invalid-response", "response-too-large", "server", "rejected", "attachment", "unconfirmed":
		return true
	}
	return false
}

func (gateway *Gateway) Configure(ctx context.Context, input ConfigureInput) (contracts.RawObject, error) {
	if input.Token != nil && (!tokenPattern.MatchString(*input.Token) || len(*input.Token) > 512) || input.ForwardMode != nil && *input.ForwardMode != ForwardUnread && *input.ForwardMode != ForwardAll {
		return nil, ErrConfig
	}
	if err := acquire(ctx, gateway.admin); err != nil {
		return nil, err
	}
	defer func() { <-gateway.admin }()
	if input.Token == nil && input.Enabled == nil {
		gateway.mu.Lock()
		if gateway.closed {
			gateway.mu.Unlock()
			return nil, ErrClosed
		}
		mode, combine := gateway.config.ForwardMode, gateway.config.CombineReplies
		if input.ForwardMode != nil {
			gateway.config.ForwardMode = *input.ForwardMode
		}
		if input.CombineReplies != nil {
			gateway.config.CombineReplies = *input.CombineReplies
		}
		err := gateway.saveLocked(ctx)
		if err != nil {
			gateway.config.ForwardMode, gateway.config.CombineReplies = mode, combine
		}
		gateway.mu.Unlock()
		if err != nil {
			return nil, err
		}
		gateway.changed()
		gateway.Wake()
		return gateway.Status(), nil
	}
	gateway.mu.Lock()
	config := gateway.config
	gateway.mu.Unlock()
	token, enabled := config.Token, config.Enabled
	if input.Token != nil {
		token = input.Token
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if enabled && token == nil {
		return nil, ErrConfig
	}
	bot := config.Bot
	if token != nil && (input.Token != nil || input.Enabled != nil && enabled) {
		var err error
		bot, err = gateway.verify(ctx, *token, enabled)
		if err != nil {
			return nil, err
		}
	}
	if err := gateway.stopLoops(ctx); err != nil {
		return nil, err
	}
	if err := gateway.operation(ctx); err != nil {
		return nil, err
	}
	gateway.mu.Lock()
	before := gateway.config
	gateway.config.Token, gateway.config.Enabled, gateway.config.Bot = token, enabled, bot
	if input.ForwardMode != nil {
		gateway.config.ForwardMode = *input.ForwardMode
	}
	if input.CombineReplies != nil {
		gateway.config.CombineReplies = *input.CombineReplies
	}
	gateway.config.LastError, gateway.config.PollError = nil, nil
	if input.Token != nil && (before.Token == nil || *before.Token != *input.Token) {
		gateway.config.Owner, gateway.config.Pairing = nil, nil
		gateway.config.Offset = 0
		gateway.config.Outbox, gateway.config.Receipts, gateway.config.ResultKeys = []*OutboxItem{}, []Receipt{}, []string{}
	}
	err := gateway.saveLocked(ctx)
	if err != nil {
		gateway.config = before
	}
	gateway.mu.Unlock()
	<-gateway.operations
	gateway.Start()
	if err != nil {
		return nil, err
	}
	gateway.changed()
	return gateway.Status(), nil
}

func (gateway *Gateway) Pair(ctx context.Context) (PairResult, error) {
	if err := acquire(ctx, gateway.admin); err != nil {
		return PairResult{}, err
	}
	defer func() { <-gateway.admin }()
	if err := gateway.operation(ctx); err != nil {
		return PairResult{}, err
	}
	defer func() { <-gateway.operations }()
	code := make([]byte, 16)
	if count, err := gateway.options.Random(code); err != nil || count != len(code) {
		return PairResult{}, ErrConfig
	}
	gateway.mu.Lock()
	if !gateway.config.Enabled || gateway.config.Token == nil || gateway.config.Bot == nil || gateway.config.Owner != nil {
		gateway.mu.Unlock()
		return PairResult{}, ErrConfig
	}
	text, expires := hex.EncodeToString(code), gateway.options.Now().Add(10*time.Minute).UnixMilli()
	previous := gateway.config.Pairing
	gateway.config.Pairing = &Pairing{digest(text), expires}
	err := gateway.saveLocked(ctx)
	if err != nil {
		gateway.config.Pairing = previous
	}
	bot := gateway.config.Bot.Username
	gateway.mu.Unlock()
	if err != nil {
		return PairResult{}, err
	}
	gateway.changed()
	return PairResult{text, expires, "https://t.me/" + bot + "?start=" + text}, nil
}

func (gateway *Gateway) Disconnect(ctx context.Context, clearToken bool) (contracts.RawObject, error) {
	if err := acquire(ctx, gateway.admin); err != nil {
		return nil, err
	}
	defer func() { <-gateway.admin }()
	if err := gateway.stopLoops(ctx); err != nil {
		return nil, err
	}
	if err := gateway.operation(ctx); err != nil {
		return nil, err
	}
	defer func() { <-gateway.operations }()
	gateway.mu.Lock()
	gateway.config.Enabled, gateway.config.Owner, gateway.config.Pairing = false, nil, nil
	if clearToken {
		gateway.config.Token, gateway.config.Bot, gateway.config.Offset = nil, nil, 0
	}
	for _, item := range gateway.config.Outbox {
		if item.Status == OutboxQueued {
			item.Status = OutboxFailed
			item.Error = pointer("Telegram was disconnected before delivery")
		}
	}
	err := gateway.saveLocked(ctx)
	gateway.mu.Unlock()
	if err != nil {
		return nil, err
	}
	gateway.changed()
	return gateway.Status(), nil
}

func (gateway *Gateway) Close(ctx context.Context) error {
	gateway.cancel()
	gateway.mu.Lock()
	gateway.closed = true
	gateway.mu.Unlock()
	if err := acquire(ctx, gateway.admin); err != nil {
		return err
	}
	defer func() { <-gateway.admin }()
	if err := gateway.stopLoops(ctx); err != nil {
		return err
	}
	if err := acquire(ctx, gateway.operations); err != nil {
		return err
	}
	<-gateway.operations
	return nil
}
