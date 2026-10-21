package work

import (
	"context"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
)

// ConversationContext reloads canonical thread history without requesting a
// model turn. Both initial and refreshed voice references use the same exact
// conversation/thread binding and current reaction snapshot.
func (value *Engine) ConversationContext(ctx context.Context, _ bool) (string, error) {
	conversationID := value.store.ConversationID()
	threadID, err := value.Thread(ctx)
	if err != nil {
		return "", err
	}
	current := func() bool {
		state := value.store.Snapshot()
		return state.ConversationID == conversationID && state.ThreadID.Value == threadID && state.ThreadRuntime.Value == value.worker.RuntimeID() && state.ThreadConversationID == conversationID
	}
	result, err := value.requestOwned(ctx, "thread/read", contracts.RawObject{"threadId": raw(threadID), "includeTurns": raw(true)}, current)
	if err != nil {
		return "", err
	}
	state := value.store.Snapshot()
	if state.ConversationID != conversationID || state.ThreadID.Value != threadID || state.ThreadRuntime.Value != value.worker.RuntimeID() || state.ThreadConversationID != conversationID {
		return "", ErrStaleOwner
	}
	text, err := history.BuildConversationContext(result["thread"], threadID, state.VoiceHistory, state.CallInputHistory, conversationID)
	if err != nil {
		return "", err
	}
	return value.redact(text + "\n\n" + history.BuildReactionContext(state.Messages, history.ReactionContextOptions{})), nil
}
