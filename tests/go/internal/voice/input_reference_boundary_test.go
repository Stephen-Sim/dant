package voice

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type referencePersistenceBoundary struct {
	*store.Store
	before func(context.Context) error
}

func (p *referencePersistenceBoundary) Mutate(ctx context.Context, change func(*contracts.State) error) error {
	if p.before != nil {
		before := p.before
		p.before = nil
		if err := before(ctx); err != nil {
			return err
		}
	}
	return p.Store.Mutate(ctx, change)
}

func TestInputReferencesRejectInvalidCapabilitiesAndUnownedPersistedMessages(t *testing.T) {
	for _, kind := range []string{"missing store", "missing inject", "missing current", "nil message", "assistant", "not current", "missing saved", "changed text", "foreign call", "missing quote", "changed conversation", "deleted before mutation", "another unknown reference"} {
		t.Run(kind, func(t *testing.T) {
			persistence, err := store.Open(t.TempDir(), store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(persistence.Close)
			message := &contracts.ChatMessage{ID: "message", Role: contracts.RoleUser, Text: "Authored request", VoiceCallID: "call"}
			if kind == "missing quote" {
				message.ReplyTo = contracts.Some("missing quoted message")
			}
			message, err = persistence.Add(t.Context(), message)
			if err != nil {
				t.Fatal(err)
			}
			boundary := &referencePersistenceBoundary{Store: persistence}
			options := ReferenceOptions{Store: boundary, Current: func(string, string, string) bool { return true }, Inject: func(context.Context, string, func() bool) (contracts.RawObject, error) {
				t.Fatal("rejected reference reached a provider")
				return nil, nil
			}}
			switch kind {
			case "missing store":
				options.Store = nil
			case "missing inject":
				options.Inject = nil
			case "missing current":
				options.Current = nil
			case "nil message":
				message = nil
			case "assistant":
				message.Role = contracts.RoleAssistant
			case "not current":
				options.Current = func(string, string, string) bool { return false }
			case "missing saved":
				message.ID = "missing"
			case "changed text":
				message.Text = "Changed caller input"
			case "foreign call":
				message.VoiceCallID = "foreign"
				if _, err := persistence.Update(t.Context(), message.ID, contracts.MessagePatch{"voiceCallId": []byte(`"foreign"`)}); err != nil {
					t.Fatal(err)
				}
			case "changed conversation", "deleted before mutation":
				boundary.before = func(ctx context.Context) error {
					return persistence.Mutate(ctx, func(state *contracts.State) error {
						if kind == "changed conversation" {
							state.ConversationID = "2daf5179-c6e4-46df-b7d6-2c6fe6bea7c7"
						} else {
							state.Messages = nil
						}
						return nil
					})
				}
			case "another unknown reference":
				if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "other", Role: contracts.RoleUser, Text: "Previous unknown submission", CallContext: object(map[string]any{"callId": "call", "status": ReferenceUnknown})}); err != nil {
					t.Fatal(err)
				}
			}
			refs, err := NewInputReferences(options)
			if kind == "missing store" || kind == "missing inject" || kind == "missing current" {
				if !errors.Is(err, ErrCallInput) {
					t.Fatal("missing reference capability accepted", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := refs.Remember(t.Context(), message, "call"); err == nil {
				t.Fatal("invalid or changed reference was persisted", kind)
			}
			if len(persistence.Snapshot().CallInputHistory) != 0 {
				t.Fatal("rejected input created a durable reference receipt")
			}
		})
	}
}

func TestReferenceOwnershipRecheckProvesUnsentAndLateOwnerMutationStaysUnknown(t *testing.T) {
	for _, changeDuringSend := range []bool{false, true} {
		t.Run(map[bool]string{false: "before send", true: "after send"}[changeDuringSend], func(t *testing.T) {
			persistence, err := store.Open(t.TempDir(), store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer persistence.Close()
			if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "quote", Role: contracts.RoleAssistant, Text: "An authored answer"}); err != nil {
				t.Fatal(err)
			}
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "message", Role: contracts.RoleUser, Text: "Continue this", VoiceCallID: "call", ReplyTo: contracts.Some("quote")})
			if err != nil {
				t.Fatal(err)
			}
			checks, injections := 0, 0
			refs, err := NewInputReferences(ReferenceOptions{
				Store:   persistence,
				Current: func(string, string, string) bool { checks++; return changeDuringSend || checks == 1 },
				Inject: func(ctx context.Context, text string, _ func() bool) (contracts.RawObject, error) {
					injections++
					if !strings.Contains(text, "An authored answer") {
						t.Fatal("current typed reference lost its authored quote")
					}
					_, err := persistence.Update(ctx, message.ID, contracts.MessagePatch{"text": []byte(`"Explicitly edited owner"`)})
					return nil, err
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			var input *VoiceInputError
			if err := refs.Remember(t.Context(), message, "call"); !errors.As(err, &input) || input.UnknownOutcome != changeDuringSend {
				t.Fatal("reference result lost its before/after-transmission uncertainty", err)
			}
			if changeDuringSend && injections != 1 || !changeDuringSend && injections != 0 {
				t.Fatal("reference was repeated after its owner changed")
			}
			state := persistence.Snapshot()
			if len(state.CallInputHistory) != 1 || textField(state.Messages[1].CallContext, "status") == string(ReferenceSubmitted) {
				t.Fatal("unconfirmed reference acquired a successful durable receipt")
			}
		})
	}
}
