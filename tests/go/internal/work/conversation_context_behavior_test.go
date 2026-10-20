package work

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

const canonicalBehaviorThread = `{"id":"thread-fixture","turns":[{"id":"canonical-fixture-turn","items":[{"id":"canonical-user","type":"userMessage","content":[{"type":"text","text":"canonical user fixture"}]},{"id":"canonical-assistant","type":"agentMessage","text":"canonical assistant fixture-secret"},{"id":"canonical-tool","type":"mcpToolCall","text":"tool output must not become dialogue"}]}]}`

func TestNativeConversationReferenceUsesCanonicalHistoryWithoutExecutingIt(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-secret", "[redacted]")
	}
	openNativeBehaviorThread(t, engine, worker)
	if _, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "cached text must not substitute for canonical history"}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	var reference string
	go func() {
		var err error
		reference, err = engine.ConversationContext(context.Background(), true)
		result <- err
	}()
	request := nextRequest(t, worker, "thread/read")
	if eventString(request.params, "threadId") != "thread-fixture" || string(request.params["includeTurns"]) != "true" {
		t.Fatal("native context read was not scoped to its acknowledged thread")
	}
	request.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(canonicalBehaviorThread)}}
	if err := awaitWorkAction(t, result); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reference, "canonical user fixture") || !strings.Contains(reference, "canonical assistant [redacted]") || !strings.Contains(reference, "not new requests") {
		t.Fatal("canonical reference lost dialogue, redaction or its authority boundary")
	}
	for _, forbidden := range []string{"fixture-secret", "tool output must not become dialogue", "cached text must not substitute"} {
		if strings.Contains(reference, forbidden) {
			t.Fatal("native context exposed a secret, tool output or substituted cached dialogue")
		}
	}
	if len(persistence.Snapshot().Messages) != 1 || engine.Snapshot().Active != nil {
		t.Fatal("building a reference created chat messages or execution")
	}
	assertWorkerQuiet(t, worker)
}

func TestLateOrInvalidConversationReferencesNeverReturnAnotherConversationsContext(t *testing.T) {
	for _, mode := range []string{"replaced-conversation", "invalid-thread", "read-failed"} {
		t.Run(mode, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			openNativeBehaviorThread(t, engine, worker)
			conversationID := persistence.ConversationID()
			result := make(chan error, 1)
			var reference string
			go func() {
				var err error
				reference, err = engine.ConversationContext(context.Background(), false)
				result <- err
			}()
			request := nextRequest(t, worker, "thread/read")
			response := fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(canonicalBehaviorThread)}}
			switch mode {
			case "replaced-conversation":
				if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
					state.ConversationID = "93fb781e-98b1-467e-a435-8bd4c3291b14"
					state.ThreadID = contracts.Null[string]()
					state.ThreadRuntime = contracts.Null[string]()
					state.ThreadConversationID = ""
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if persistence.ConversationID() == conversationID {
					t.Fatal("replacement fixture did not retire the old conversation")
				}
			case "invalid-thread":
				response.value["thread"] = json.RawMessage(`{"id":"different-thread","turns":[]}`)
			case "read-failed":
				response.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
			}
			request.result <- response
			err := awaitWorkAction(t, result)
			if err == nil || reference != "" {
				t.Fatal("stale or invalid thread history became authoritative context")
			}
			if mode == "replaced-conversation" && !errors.Is(err, ErrStaleOwner) {
				t.Fatal("late thread read did not retain its stale identity classification", err)
			}
			if len(persistence.Snapshot().Messages) != 0 || engine.Snapshot().Active != nil {
				t.Fatal("failed reference read changed history or started a task")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
