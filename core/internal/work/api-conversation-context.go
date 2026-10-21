package work

import (
	"context"

	"github.com/Stephen-Sim/dant/core/internal/history"
)

func (value *Engine) APIConversationContext(ctx context.Context, reactionsOnly bool) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	state := value.store.Snapshot()
	text, err := history.BuildAPIConversationContext(state.Messages, reactionsOnly)
	if err != nil {
		return "", err
	}
	text = value.redact(text)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if value.store.ConversationID() != state.ConversationID {
		return "", ErrStaleOwner
	}
	return text, nil
}
