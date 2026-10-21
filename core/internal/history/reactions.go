package history

import (
	"context"
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

//go:embed assets/reactions.txt
var reactionData string
var reactionSet = sync.OnceValue(func() map[string]bool {
	result := make(map[string]bool)
	for _, value := range strings.Split(reactionData, "\n") {
		if value != "" {
			result[value] = true
		}
	}
	return result
})

// IsReaction accepts one complete RGI sequence, never concatenated emoji,
// independent components, whitespace, controls or arbitrary user strings.
func IsReaction(value string) bool {
	if value == "" || !utf8.ValidString(value) || contracts.UTF16Length(value) > 64 {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || contracts.TrimText(string(character)) == "" {
			return false
		}
	}
	return reactionSet()[value]
}

func (value *History) SetReactions(ctx context.Context, id, conversationID string, reactions []string) ([]string, error) {
	if len(reactions) > 64 {
		return nil, fail(400, "invalid_reactions", "Invalid message reactions.")
	}
	clean := []string{}
	for _, reaction := range reactions {
		if !IsReaction(reaction) {
			return nil, fail(400, "invalid_reactions", "Invalid message reactions.")
		}
		if !contains(clean, reaction) {
			clean = append(clean, reaction)
		}
	}
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return fail(409, "conversation_changed", "The conversation changed.")
		}
		selected, err := message(state, id)
		if err != nil {
			return err
		}
		if selected.Role != contracts.RoleUser && selected.Role != contracts.RoleAssistant {
			return fail(409, "invalid_reaction_target", "Only chat messages can receive reactions.")
		}
		selected.Reactions = clean
		selected.ReactionUpdatedAt = contracts.Some(value.store.Timestamp())
		return nil
	})
	return clean, err
}

func (value *History) ToggleReaction(ctx context.Context, id, conversationID, reaction string) ([]string, error) {
	if !IsReaction(reaction) {
		return nil, fail(400, "invalid_reaction", "Use one supported emoji.")
	}
	var result []string
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return fail(409, "conversation_changed", "The conversation changed.")
		}
		selected, err := message(state, id)
		if err != nil {
			return err
		}
		if selected.Role != contracts.RoleUser && selected.Role != contracts.RoleAssistant {
			return fail(409, "invalid_reaction_target", "Only chat messages can receive reactions.")
		}
		result = []string{}
		present := false
		for _, prior := range selected.Reactions {
			if prior == reaction {
				present = true
			} else {
				result = append(result, prior)
			}
		}
		if !present {
			result = append(result, reaction)
		}
		selected.Reactions = result
		selected.ReactionUpdatedAt = contracts.Some(value.store.Timestamp())
		return nil
	})
	return result, err
}

func (value *History) SetAssistantReaction(ctx context.Context, id, conversationID string, reaction contracts.Optional[string]) (bool, error) {
	if !reaction.Present || !reaction.Null && !IsReaction(reaction.Value) {
		return false, fail(400, "invalid_reaction", "Use one supported emoji or null.")
	}
	changed := false
	err := value.store.Mutate(ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return fail(409, "conversation_changed", "The conversation changed.")
		}
		selected, err := message(state, id)
		if err != nil {
			return err
		}
		if selected.Role != contracts.RoleUser {
			return fail(409, "invalid_reaction_target", "Assistant reactions require a real user message.")
		}
		previous := selected.AssistantReaction
		if (previous.Null || !previous.Present) && reaction.Null || previous.Present && !previous.Null && !reaction.Null && previous.Value == reaction.Value {
			return nil
		}
		selected.AssistantReaction = reaction
		selected.AssistantReactionUpdatedAt = contracts.Some(value.store.Timestamp())
		changed = true
		return nil
	})
	return changed, err
}

func reactionJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
