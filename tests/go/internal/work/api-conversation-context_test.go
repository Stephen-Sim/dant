package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPIConversationReferenceNeverRequestsACodexThreadOrChangesPersistence(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	if _, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "visible reference", Reactions: []string{"👍"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "unreacted complete conversation"}); err != nil {
		t.Fatal(err)
	}
	revision := persistence.Revision()
	text, err := engine.APIConversationContext(context.Background(), false)
	if err != nil || !strings.Contains(text, "visible reference") || persistence.Revision() != revision {
		t.Fatal("read-only API reference required Codex or changed chat", err)
	}
	reactions, err := engine.APIConversationContext(context.Background(), true)
	if err != nil || strings.Contains(reactions, "unreacted complete conversation") || !strings.Contains(reactions, "👍") {
		t.Fatal("API reaction refresh read complete subscription history", err)
	}
	select {
	case request := <-worker.requests:
		t.Fatalf("API voice reference created a subscription operation: %s", request.method)
	default:
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.APIConversationContext(cancelled, false); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled reference ignored its caller", err)
	}
}
