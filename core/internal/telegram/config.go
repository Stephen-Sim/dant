package telegram

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

var tokenPattern = regexp.MustCompile(`^[0-9]{5,20}:[A-Za-z0-9_-]{20,200}$`)
var botNamePattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
var pairingPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func raw(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}
func object(value any) contracts.RawObject {
	data := raw(value)
	result, _ := contracts.DecodeObject(data, len(data))
	return result
}
func field(value contracts.RawObject, key string) string {
	var result string
	_ = json.Unmarshal(value[key], &result)
	return result
}
func pointer(value string) *string { return &value }
func number(value int64) *int64    { return &value }
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func identifier(value json.RawMessage) string {
	var result int64
	if !contracts.ValidUnicodeJSON(value) || json.Unmarshal(value, &result) != nil || result <= 0 || result > 9007199254740991 {
		return ""
	}
	return strconv.FormatInt(result, 10)
}

func (item OutboxItem) MarshalJSON() ([]byte, error) {
	type plain OutboxItem
	data, err := json.Marshal(plain(item))
	if err != nil || len(item.legacyText) == 0 || item.Text != item.decodedText {
		return data, err
	}
	value, err := contracts.DecodeObject(data, MaxConfigBytes)
	if err != nil {
		return nil, err
	}
	value["text"] = bytes.Clone(item.legacyText)
	return json.Marshal(value)
}

func (item *OutboxItem) UnmarshalJSON(data []byte) error {
	type plain OutboxItem
	var result plain
	value, err := contracts.DecodeObject(data, MaxConfigBytes)
	if err != nil || json.Unmarshal(data, &result) != nil {
		return ErrConfig
	}
	*item = OutboxItem(result)
	if text, ok := value["text"]; ok {
		item.legacyText = bytes.Clone(text)
		item.decodedText = item.Text
	}
	return nil
}

func defaultConfig() Config {
	return Config{Version: 1, DeliveryVersion: 2, ForwardMode: ForwardUnread, CombineReplies: true, Outbox: []*OutboxItem{}, Receipts: []Receipt{}, ResultKeys: []string{}}
}

func restoreConfig(data []byte) (Config, bool, error) {
	value, err := contracts.DecodeObject(data, MaxConfigBytes)
	result := defaultConfig()
	if err != nil || json.Unmarshal(data, &result) != nil {
		return Config{}, false, ErrConfig
	}
	if result.Offset < 0 || result.Offset > 9007199254740991 || len(result.Outbox) > MaxOutbox || len(result.Receipts) > maxReceipts || result.Outbox == nil || result.Receipts == nil || result.ResultKeys == nil || result.ForwardMode != ForwardUnread && result.ForwardMode != ForwardAll {
		return Config{}, false, ErrConfig
	}
	for _, key := range []string{"enabled", "combineReplies", "version", "deliveryVersion", "offset", "outbox", "receipts", "resultKeys"} {
		if supplied, ok := value[key]; ok && bytes.Equal(bytes.TrimSpace(supplied), []byte("null")) {
			return Config{}, false, ErrConfig
		}
	}
	changed := value["forwardMode"] == nil || value["combineReplies"] == nil
	if value["deliveryVersion"] == nil && len(result.ResultKeys) > 0 && result.Owner != nil {
		result.Owner.SyncVersion = 0
		changed = true
	}
	var rawOutbox []contracts.RawObject
	if supplied, exists := value["outbox"]; exists && json.Unmarshal(supplied, &rawOutbox) != nil {
		return Config{}, false, ErrConfig
	}
	for _, entry := range rawOutbox {
		for _, key := range []string{"id", "botId", "chatId", "userId", "status", "attempts", "at"} {
			if entry[key] == nil || bytes.Equal(bytes.TrimSpace(entry[key]), []byte("null")) {
				return Config{}, false, ErrConfig
			}
		}
		if field(entry, "kind") == "text" && (entry["text"] == nil || bytes.Equal(bytes.TrimSpace(entry["text"]), []byte("null"))) {
			return Config{}, false, ErrConfig
		}
	}
	var rawReceipts []contracts.RawObject
	if supplied, exists := value["receipts"]; exists && json.Unmarshal(supplied, &rawReceipts) != nil {
		return Config{}, false, ErrConfig
	}
	for _, entry := range rawReceipts {
		if entry["id"] == nil || bytes.Equal(bytes.TrimSpace(entry["id"]), []byte("null")) {
			return Config{}, false, ErrConfig
		}
	}
	for _, item := range result.Outbox {
		if item == nil || item.ID == "" || item.BotID == "" || item.ChatID == "" || item.UserID == "" || item.Attempts < 0 || item.At < 0 || item.Kind != "text" && item.Kind != "document" || item.Kind == "document" && item.AttachmentID == "" {
			return Config{}, false, ErrConfig
		}
		switch item.Status {
		case OutboxQueued, OutboxSent, OutboxSuppressed, OutboxFailed, OutboxUnknown:
		case OutboxSending:
			item.Status = OutboxUnknown
			item.Error = pointer("Delivery was interrupted before confirmation and was not resent")
			changed = true
		default:
			return Config{}, false, ErrConfig
		}
		if item.PairingID == "" {
			if owner := result.Owner; owner != nil && result.Bot != nil && item.BotID == result.Bot.ID && item.ChatID == owner.ChatID && item.UserID == owner.UserID {
				item.PairingID = owner.PairingID
			} else {
				item.Status = OutboxFailed
				item.Error = pointer("The Telegram pairing identity could not be confirmed")
			}
			changed = true
		}
	}
	for index := range result.Receipts {
		item := &result.Receipts[index]
		if item.ID < 0 || item.ID >= 9007199254740991 {
			return Config{}, false, ErrConfig
		}
		switch item.Status {
		case ReceiptDone, ReceiptFailed, ReceiptUnknown:
		case ReceiptProcessing:
			item.Status = ReceiptUnknown
			result.LastError = pointer("A Telegram update was interrupted; its task was not replayed")
			changed = true
		default:
			return Config{}, false, ErrConfig
		}
	}
	if owner := result.Owner; owner != nil && (owner.ChatID == "" || owner.UserID == "" || owner.PairingID == "" || len(owner.PairingID) > 128) {
		return Config{}, false, ErrConfig
	}
	if result.Bot != nil && (result.Bot.ID == "" || !botNamePattern.MatchString(result.Bot.Username)) {
		return Config{}, false, ErrConfig
	}
	if result.Pairing != nil && (!hashPattern.MatchString(result.Pairing.Hash) || result.Pairing.ExpiresAt < 0) {
		return Config{}, false, ErrConfig
	}
	return result, changed, nil
}

func (gateway *Gateway) saveLocked(ctx context.Context) error {
	if ctx.Err() != nil || !gateway.currentDirectory() {
		return ErrConfig
	}
	data, err := json.Marshal(gateway.config)
	if err != nil || len(data) > MaxConfigBytes {
		return ErrConfig
	}
	target, targetErr := files.CaptureIdentity(gateway.file)
	if targetErr != nil && !errors.Is(targetErr, fs.ErrNotExist) || targetErr == nil && !target.Mode().IsRegular() {
		return ErrConfig
	}
	stored, err := files.ReadRegular(gateway.file, MaxConfigBytes)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return ErrConfig
	}
	if ctx.Err() != nil || !gateway.currentDirectory() {
		return ErrConfig
	}
	// Idle mirror scans and completed empty polls still reach this boundary.
	// Replacing identical bytes invalidates an otherwise stable agent-data backup.
	if err == nil && bytes.Equal(stored, data) {
		current, err := files.CaptureIdentity(gateway.file)
		if err != nil || target == nil || !current.Mode().IsRegular() || !os.SameFile(target, current) ||
			target.Size() != current.Size() || !target.ModTime().Equal(current.ModTime()) ||
			ctx.Err() != nil || !gateway.currentDirectory() {
			return ErrConfig
		}
		privateMode := current.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == 0600
		if contracts.RuntimeOperatingSystem(runtime.GOOS) == contracts.RuntimeOperatingSystemWindows || privateMode {
			return nil
		}
	}
	if err = files.WriteAtomic(ctx, gateway.file, data, 0600); err != nil {
		return ErrConfig
	}
	return nil
}

func (gateway *Gateway) currentDirectory() bool {
	current, err := files.CaptureIdentity(gateway.directory)
	return err == nil && current.IsDir() && os.SameFile(gateway.identity, current)
}

func readConfig(directory string) (string, fs.FileInfo, Config, bool, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", nil, Config{}, false, ErrConfig
	}
	absolute, err = files.OrdinaryDirectory(absolute, true)
	if err != nil {
		return "", nil, Config{}, false, ErrConfig
	}
	identity, err := files.CaptureIdentity(absolute)
	if err != nil {
		return "", nil, Config{}, false, ErrConfig
	}
	data, err := files.ReadRegular(filepath.Join(absolute, "telegram.json"), MaxConfigBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return absolute, identity, defaultConfig(), false, nil
	}
	if err != nil {
		return "", nil, Config{}, false, ErrConfig
	}
	config, changed, err := restoreConfig(data)
	return absolute, identity, config, changed, err
}
