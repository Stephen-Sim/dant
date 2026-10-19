package work

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

const maxMCPDeliveryTextCharacters = 200_000

func receiptFalsy(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) == 0 || bytes.Equal(raw, []byte("null")) || bytes.Equal(raw, []byte("false")) || bytes.Equal(raw, []byte(`""`)) || bytes.Equal(raw, []byte("0"))
}

func equalReceiptText(left, right json.RawMessage) bool {
	first, firstErr := contracts.DecodeJSONTextUnits(left)
	second, secondErr := contracts.DecodeJSONTextUnits(right)
	return firstErr == nil && secondErr == nil && slices.Equal(first, second)
}

func (value *Engine) acceptMCPResult(ctx context.Context, active *execution, item contracts.RawObject, owner ToolContext) error {
	tool := eventString(item, "tool")
	if eventString(item, "server") != "dant_desktop" || eventString(item, "status") != "completed" || !receiptFalsy(item["error"]) || tool != "send_chat_message" && tool != "create_voice_message" && tool != "react_message" {
		return nil
	}
	result, err := contracts.DecodeObject(item["result"], runtime.MaxRPCFrameBytes)
	if err != nil || !receiptFalsy(result["isError"]) {
		return nil
	}
	payload, err := contracts.DecodeObject(result["structuredContent"], runtime.MaxRPCFrameBytes)
	if err != nil {
		var content []contracts.RawObject
		if json.Unmarshal(result["content"], &content) != nil || len(content) == 0 || eventString(content[0], "type") != "text" {
			return nil
		}
		var text string
		if json.Unmarshal(content[0]["text"], &text) != nil || contracts.UTF16Length(text) > maxMCPDeliveryTextCharacters {
			return nil
		}
		payload, err = contracts.DecodeObject([]byte(text), runtime.MaxRPCFrameBytes)
		if err != nil {
			return nil
		}
	}
	arguments, _ := contracts.DecodeObject(item["arguments"], runtime.MaxRPCFrameBytes)
	id := eventString(item, "id")
	if id == "" || owner.IsCurrent == nil || !owner.IsCurrent() {
		return ErrStaleOwner
	}
	var text, path string
	var reaction contracts.Optional[string]
	messageID := ""
	switch tool {
	case "send_chat_message":
		delivery, err := contracts.DecodeObject(payload["dantMessage"], runtime.MaxRPCFrameBytes)
		if err != nil || !equalReceiptText(delivery["text"], arguments["text"]) || json.Unmarshal(delivery["text"], &text) != nil {
			return nil
		}
	case "react_message":
		delivery, err := contracts.DecodeObject(payload["dantReaction"], runtime.MaxRPCFrameBytes)
		messageID = eventString(delivery, "messageId")
		if err != nil || messageID == "" || messageID != eventString(arguments, "messageId") {
			return nil
		}
		if bytes.Equal(bytes.TrimSpace(delivery["emoji"]), []byte("null")) && bytes.Equal(bytes.TrimSpace(arguments["emoji"]), []byte("null")) {
			reaction = contracts.Null[string]()
		} else if equalReceiptText(delivery["emoji"], arguments["emoji"]) {
			if json.Unmarshal(delivery["emoji"], &text) != nil || !history.IsReaction(text) {
				return nil
			}
			reaction = contracts.Some(text)
		} else {
			return nil
		}
	case "create_voice_message":
		file, err := contracts.DecodeObject(payload["voiceFile"], runtime.MaxRPCFrameBytes)
		path = eventString(file, "path")
		if err != nil || !filepath.IsAbs(path) || strings.ContainsRune(path, '\x00') {
			return nil
		}
	}

	value.mu.Lock()
	if !value.currentLocked(active) || active.stopRequested || active.finishing {
		value.mu.Unlock()
		return ErrStaleOwner
	}
	if active.deliveredMCP == nil {
		active.deliveredMCP = make(map[string]bool)
	}
	if active.deliveredMCP[id] {
		value.mu.Unlock()
		return nil
	}
	if len(active.deliveredMCP) >= 128 {
		value.mu.Unlock()
		return runtime.ErrBackpressure
	}
	active.deliveredMCP[id] = true
	value.mu.Unlock()

	switch tool {
	case "send_chat_message":
		_, err = value.DeliverText(ctx, text, owner)
	case "react_message":
		_, err = history.New(value.store, nil).SetAssistantReaction(ctx, messageID, owner.ConversationID, reaction)
	default:
		var archived []contracts.Attachment
		archived, err = value.archiveExplicit(ctx, active, "", []string{path})
		if err == nil {
			_, err = value.DeliverAttachments(ctx, archived, owner)
		}
	}
	return err
}
