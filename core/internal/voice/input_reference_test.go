package voice

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestInputReferencePersistsReceiptAndDoesNotReplayAfterRestart(t *testing.T) {
	for _, test := range []struct {
		name    string
		err     error
		status  ReferenceStatus
		unknown bool
	}{
		{"acknowledged", nil, ReferenceSubmitted, false},
		{"lost acknowledgement", runtime.ErrDisconnected, ReferenceUnknown, true},
		{"explicit rejection", &runtime.OperationError{UnknownOutcome: false}, ReferenceFailed, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			persistence, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { persistence.Close() })
			message, err := persistence.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleUser, Text: "request", VoiceCallID: "call-one"})
			if err != nil {
				t.Fatal(err)
			}
			var injections atomic.Int32
			options := ReferenceOptions{
				Store: persistence,
				Current: func(conversation, callID, messageID string) bool {
					return conversation == persistence.Snapshot().ConversationID && callID == "call-one" && messageID == message.ID
				},
				Inject: func(context.Context, string, func() bool) (contracts.RawObject, error) {
					injections.Add(1)
					return contracts.RawObject{}, test.err
				},
			}
			refs, err := NewInputReferences(options)
			if err != nil {
				t.Fatal(err)
			}
			err = refs.Remember(ctx, message, "call-one")
			if (err != nil) != (test.err != nil) {
				t.Fatal("unexpected reference result", err)
			}
			if test.err != nil {
				var input *VoiceInputError
				if !errors.As(err, &input) || input.UnknownOutcome != test.unknown {
					t.Fatal("incorrect uncertainty classification", err)
				}
			}
			state := persistence.Snapshot()
			if textField(state.Messages[0].CallContext, "status") != string(test.status) || len(state.CallInputHistory) != 1 {
				t.Fatal("reference fence was not durable")
			}
			persistence.Close()
			reopened, err := store.Open(directory, store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			options.Store = reopened
			refs, err = NewInputReferences(options)
			if err != nil {
				t.Fatal(err)
			}
			_ = refs.Remember(ctx, message, "call-one")
			if injections.Load() != 1 {
				t.Fatal("durable reference was replayed")
			}
		})
	}
}

func TestInputReferenceConversationChangeCannotApplyLateReceipt(t *testing.T) {
	ctx := context.Background()
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer persistence.Close()
	message, err := persistence.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleUser, Text: "request", VoiceCallID: "call-one"})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := NewInputReferences(ReferenceOptions{
		Store:   persistence,
		Current: func(string, string, string) bool { return true },
		Inject: func(ctx context.Context, _ string, _ func() bool) (contracts.RawObject, error) {
			return nil, persistence.Mutate(ctx, func(state *contracts.State) error {
				state.ConversationID = "00000000-0000-4000-8000-000000000002"
				state.Messages = nil
				state.CallInputHistory = nil
				return nil
			})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = refs.Remember(ctx, message, "call-one")
	var input *VoiceInputError
	if !errors.As(err, &input) || !input.UnknownOutcome {
		t.Fatal("late result was treated as safely applied", err)
	}
	if state := persistence.Snapshot(); len(state.Messages) != 0 || len(state.CallInputHistory) != 0 {
		t.Fatal("late receipt modified the new conversation")
	}
}
