package history

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const apiContextAttachmentNames = 5

// BuildAPIConversationContext projects the visible shared chat. API voice uses
// its own provider credentials; reading its references cannot open, resume or
// require authentication for a Codex subscription thread.
func BuildAPIConversationContext(messages []*contracts.ChatMessage, reactionsOnly bool) (string, error) {
	reactions := BuildReactionContext(messages, ReactionContextOptions{})
	if reactionsOnly {
		return reactions, nil
	}

	var lines strings.Builder
	for _, message := range messages {
		if message == nil || message.Role != contracts.RoleUser && message.Role != contracts.RoleAssistant {
			continue
		}
		text := legacyJSONText(message.Text, message.LegacyText, "text")
		if _, err := contracts.DecodeJSONTextUnits(text); err != nil {
			return "", ErrConversationContext
		}
		names := make([]json.RawMessage, 0, min(apiContextAttachmentNames, len(message.Attachments)))
		for _, file := range message.Attachments[:min(apiContextAttachmentNames, len(message.Attachments))] {
			name := legacyJSONText(file.Name, file.LegacyText, "name")
			if _, err := contracts.DecodeJSONTextUnits(name); err != nil {
				return "", ErrConversationContext
			}
			names = append(names, name)
		}
		var reaction *string
		if value, present := message.AssistantReaction.Get(); present && value != "" {
			reaction = &value
		}

		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		err := encoder.Encode(struct {
			MessageID         string            `json:"messageId"`
			Role              contracts.Role    `json:"role"`
			Text              json.RawMessage   `json:"text"`
			Attachments       []json.RawMessage `json:"attachments"`
			AssistantReaction *string           `json:"assistantReaction"`
		}{message.ID, message.Role, text, names, reaction})
		if err != nil {
			return "", ErrConversationContext
		}
		if lines.Len() > 0 {
			lines.WriteByte('\n')
		}
		lines.WriteString(strings.TrimSuffix(encoded.String(), "\n"))
	}
	return lines.String() + "\n\n" + reactions, nil
}
