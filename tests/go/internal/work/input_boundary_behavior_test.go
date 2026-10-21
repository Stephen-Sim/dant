package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestPreparedInputRejectsUnavailableTaskReferencesAndUnresolvedFiles(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	failure := errors.New("isolated task-reference read failure")
	workID, turnID := savedUnfinished(t, persistence)
	for _, scenario := range []string{"foreign conversation", "missing work", "project read failed", "missing file path", "missing recognized words", "fallback path"} {
		t.Run(scenario, func(t *testing.T) {
			message := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic requested input"}
			var want error
			switch scenario {
			case "foreign conversation":
				message.WorkReply = &contracts.WorkReplyTarget{ConversationID: "foreign", WorkID: workID, TurnID: turnID}
				want = ErrStaleOwner
			case "missing work":
				message.WorkReply = &contracts.WorkReplyTarget{ConversationID: persistence.ConversationID(), WorkID: "missing", TurnID: turnID}
				want = ErrStaleOwner
			case "project read failed":
				engine.options.DurableMemory = &projectFailureMemory{readErr: failure}
				defer func() { engine.options.DurableMemory = nil }()
				message.WorkReply = &contracts.WorkReplyTarget{ConversationID: persistence.ConversationID(), WorkID: workID, TurnID: turnID}
				want = failure
			case "missing file path":
				message.Attachments = []contracts.Attachment{{ID: "fixture-file", Type: "text/plain"}}
				want = runtime.ErrInvalidProtocol
			case "missing recognized words":
				message.Attachments = []contracts.Attachment{{ID: "fixture-audio", Type: "audio/ogg", GuestPath: "/isolated/fixture.ogg"}}
				want = runtime.ErrRequestFailed
			case "fallback path":
				message.Attachments = []contracts.Attachment{{ID: "fixture-file", Type: "text/plain", Path: "/isolated/fixture.txt"}}
			}
			text, images, err := engine.messageInput(t.Context(), message, nil)
			if want != nil {
				if !errors.Is(err, want) || text != "" || images != nil {
					t.Fatal("rejected input exposed partial text or unresolved attachments", err)
				}
			} else if err != nil || !strings.Contains(text, "/isolated/fixture.txt") || len(images) != 0 {
				t.Fatal("verified legacy path was not included in its file reference", err)
			}
		})
	}
	if _, err := engine.resolveInputAttachments(t.Context(), nil); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("missing input was treated as an empty authorized message", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := engine.resolveInputAttachments(cancelled, &contracts.ChatMessage{}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled input continued resolving files", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestInputPreparationPropagatesProjectAndMemoryFailuresBeforeTurnSubmission(t *testing.T) {
	for _, phase := range []string{"project", "memory"} {
		t.Run(phase, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			failure := errors.New("isolated input-reference failure")
			message := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic current input"}
			if phase == "project" {
				workID, turnID := savedUnfinished(t, persistence)
				message.WorkReply = &contracts.WorkReplyTarget{ConversationID: persistence.ConversationID(), WorkID: workID, TurnID: turnID}
				engine.options.DurableMemory = &projectFailureMemory{readErr: failure}
			} else {
				engine.options.Memory = ReferenceMemoryFunc(func(context.Context, string, string, string) (string, error) { return "", failure })
			}
			if encoded, err := engine.prepareInput(&execution{prepare: t.Context()}, message); !errors.Is(err, failure) || encoded != nil {
				t.Fatal("failed context preparation produced a model input", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestAPIContextRejectsCancellationAndConversationReplacementDuringRedaction(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled capture", true: "replaced conversation"}[replace], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			engine.options.Redact = func(context.Context, string) string {
				if replace {
					if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
						state.ConversationID = "1c74b4bf-39e7-4058-aa8b-a33adeea231c"
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				return "Synthetic redacted context"
			}
			want := context.Canceled
			if replace {
				want = ErrStaleOwner
			}
			if text, err := engine.APIConversationContext(ctx, false); text != "" || !errors.Is(err, want) {
				t.Fatal("context captured for an ended owner was published", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
