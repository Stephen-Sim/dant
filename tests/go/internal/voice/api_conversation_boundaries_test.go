package voice

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func conversationSessionFixture(t *testing.T) (*API, *apiSession) {
	t.Helper()
	s := &apiSession{callID: "call", ctx: t.Context(), conversation: map[string]*conversationNode{}, conversationQueue: make(chan ConversationItem, 4), conversationNotify: make(chan struct{}, 1)}
	api := &API{ctx: t.Context(), session: s, options: APIOptions{RequestTimeout: defaultAPIRequestTimeout}}
	return api, s
}

func TestAPIConversationOrderingWaitsForPredecessorsAndPublishesEachFinalItemOnce(t *testing.T) {
	api, s := conversationSessionFixture(t)
	api.registerLocked(s, object(map[string]any{"id": "child", "type": "message", "role": "assistant"}), rawValue("parent"))
	s.conversation["child"].state = "final"
	s.conversation["child"].text = "second authored reply"
	api.flushConversationLocked(s)
	if len(s.conversationQueue) != 0 {
		t.Fatal("child was persisted before its missing predecessor")
	}
	api.registerLocked(s, object(map[string]any{"id": "parent", "type": "message", "role": "user", "content": []any{map[string]any{"type": "input_audio"}}}), rawValue(nil))
	api.flushConversationLocked(s)
	if len(s.conversationQueue) != 0 {
		t.Fatal("pending user transcription was skipped in conversation order")
	}
	s.conversation["parent"].state = "final"
	s.conversation["parent"].text = "first human speech"
	api.flushConversationLocked(s)
	for _, expected := range []struct {
		id, text string
		role     contracts.Role
	}{{"parent", "first human speech", contracts.RoleUser}, {"child", "second authored reply", contracts.RoleAssistant}} {
		item := <-s.conversationQueue
		if item.ItemID != expected.id || item.Text != expected.text || item.Role != expected.role || item.CallID != "call" {
			t.Fatal("final transcript lost order or speaker identity", item)
		}
	}
	api.flushConversationLocked(s)
	if len(s.conversationQueue) != 0 || s.conversationPending != 2 {
		t.Fatal("final transcript was emitted twice")
	}
	api.registerLocked(s, object(map[string]any{"id": "tool", "type": "function_call", "role": "assistant"}), nil)
	api.flushConversationLocked(s)
	if !s.conversation["tool"].emitted || s.conversation["tool"].state != "skip" {
		t.Fatal("tool metadata was treated as authored speech")
	}
}

func TestAPIConversationBoundsCyclesAndCancellationCannotBecomeReady(t *testing.T) {
	api, s := conversationSessionFixture(t)
	if api.nodeLocked(s, "") != nil || api.nodeLocked(s, strings.Repeat("x", 257)) != nil {
		t.Fatal("invalid provider transcript identity accepted")
	}
	api.registerLocked(s, object(map[string]any{"id": "cycle-a", "type": "message", "role": "assistant"}), rawValue("cycle-b"))
	api.registerLocked(s, object(map[string]any{"id": "cycle-b", "type": "message", "role": "assistant"}), rawValue("cycle-a"))
	api.flushConversationLocked(s)
	if len(s.conversationQueue) != 0 {
		t.Fatal("cyclic transcript order was invented")
	}
	s.conversation["cycle-a"].state = "final"
	s.conversation["cycle-a"].text = "cannot be ordered"
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := api.drainConversation(cancelled, s); !errors.Is(err, ErrVoiceContext) {
		t.Fatal("unresolved transcript drain became ready", err)
	}
	for i := len(s.conversation); i < maxAPIConversationItems; i++ {
		s.conversation[fmt.Sprintf("retained-%d", i)] = &conversationNode{}
	}
	if api.nodeLocked(s, "overflow") != nil || !s.conversationError {
		t.Fatal("transcript item capacity did not preserve a failure fence")
	}
	if err := api.drainConversation(t.Context(), s); !errors.Is(err, ErrVoiceContext) {
		t.Fatal("failed transcript lifecycle reported ready", err)
	}
	if err := api.ConversationReady(t.Context(), "other-call"); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("foreign call became ready", err)
	}
	fullAPI, full := conversationSessionFixture(t)
	full.conversationQueue = make(chan ConversationItem)
	fullAPI.registerLocked(full, object(map[string]any{"id": "item", "type": "message", "role": "assistant"}), rawValue(nil))
	full.conversation["item"].state = "final"
	full.conversation["item"].text = "retained"
	fullAPI.flushConversationLocked(full)
	if !full.conversationError {
		t.Fatal("full persistence queue silently dropped a final item")
	}
}

func TestAPIConversationPersistenceFailureIsJoinedAndRetainedAsUnconfirmed(t *testing.T) {
	api, s := conversationSessionFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.ctx = ctx
	notice := make(chan string, 1)
	api.options.Redact = func(text string, _ []string) string { return strings.ReplaceAll(text, "private", "[hidden]") }
	api.options.Notice = func(code string) { notice <- code }
	api.options.OnConversationItem = func(ctx context.Context, item ConversationItem) error {
		if _, ok := ctx.Deadline(); !ok || item.Text != "[hidden] speech" {
			t.Error("persistence callback lost deadline or redaction")
		}
		return errors.New("isolated persistent storage failure")
	}
	s.conversationPending = 1
	s.conversationQueue <- ConversationItem{CallID: "call", ItemID: "item", Role: contracts.RoleUser, Text: "private speech"}
	s.workers.Add(1)
	go api.conversationLoop(s)
	if code := <-notice; code != "voice_context_save_unconfirmed" {
		t.Fatal("persistence failure lost its fixed diagnostic code")
	}
	cancel()
	s.workers.Wait()
	if err := api.drainConversation(t.Context(), s); !errors.Is(err, ErrVoiceContext) {
		t.Fatal("failed final transcript was reported durable", err)
	}
}
