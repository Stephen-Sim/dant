package voice

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPITypedInputRejectsInvalidOwnershipContentAndCapacityBeforeSending(t *testing.T) {
	for _, kind := range []string{"foreign call", "paused", "missing message", "assistant message", "missing ID", "long ID", "blank text", "attachment", "missing quote", "capacity", "conversation failure", "input unknown"} {
		t.Run(kind, func(t *testing.T) {
			api, socket, _ := apiFixture(t, APIOptions{})
			startAPIFixture(t, api)
			message := &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Authored typed request"}
			input := MessageOptions{CallID: "fixture-call", Message: message}
			switch kind {
			case "foreign call":
				input.CallID = "other-call"
			case "paused":
				input.IsCurrent = func() bool { return false }
			case "missing message":
				input.Message = nil
			case "assistant message":
				message.Role = contracts.RoleAssistant
			case "missing ID":
				message.ID = ""
			case "long ID":
				message.ID = strings.Repeat("x", 129)
			case "blank text":
				message.Text = " "
			case "attachment":
				message.Attachments = []contracts.Attachment{{Name: "file.txt"}}
			case "missing quote":
				message.ReplyTo = contracts.Some("quoted-message")
			case "capacity":
				api.mu.Lock()
				for index := range maxAPIConversationItems {
					api.session.messages[fmt.Sprintf("previous-%d", index)] = &apiInput{}
				}
				api.mu.Unlock()
			case "conversation failure":
				api.mu.Lock()
				api.session.conversationError = true
				api.mu.Unlock()
			case "input unknown":
				api.mu.Lock()
				api.session.inputUnknown = true
				api.mu.Unlock()
			}
			_, err := api.Message(t.Context(), input)
			var rejected *VoiceInputError
			if !errors.As(err, &rejected) || rejected.Submission != contracts.SubmissionStatusNotSubmitted || rejected.UnconfirmedOutcome() || socket.count("conversation.item.create") != 0 {
				t.Fatal("invalid typed input reached the provider or acquired an unknown transmission", kind, err)
			}
		})
	}
}

func TestAPITypedInputCancellationBeforeTheGateIsProvenUnsent(t *testing.T) {
	for _, kind := range []string{"caller", "session"} {
		t.Run(kind, func(t *testing.T) {
			// This fixture owns no provider goroutines. The cancelled lifetime
			// is captured before the session is published to the method.
			lifetime, stop := context.WithCancel(t.Context())
			defer stop()
			s := &apiSession{callID: "call", ctx: lifetime, ready: true, status: contracts.VoiceCallStatusActive, messages: map[string]*apiInput{}, messageGate: make(chan struct{}, 1)}
			api := &API{ctx: t.Context(), session: s, options: APIOptions{
				NewID: func() string { return "input" }, RequestTimeout: time.Second,
				Redact: func(text string, _ []string) string { return text },
			}}
			s.messageGate <- struct{}{}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if kind == "caller" {
				cancel()
			} else {
				stop()
			}
			_, err := api.Message(ctx, MessageOptions{CallID: s.callID, Message: &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "current request"}})
			<-s.messageGate
			var rejected *VoiceInputError
			if !errors.As(err, &rejected) || rejected.Submission != contracts.SubmissionStatusNotSubmitted || rejected.UnknownOutcome || s.inputAck != nil {
				t.Fatal("cancelled gate wait sent or ambiguously classified an input", err)
			}
		})
	}
}

func TestPendingTypedInputCannotBeReplayedWhenItsSecondCallerCancels(t *testing.T) {
	api, socket, _ := apiFixture(t, APIOptions{})
	startAPIFixture(t, api)
	message := &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Current request"}
	api.mu.Lock()
	s := api.session
	api.mu.Unlock()
	text, err := BuildCallInput(message, nil, func(text string) string { return api.redact(s, text) })
	if err != nil {
		t.Fatal(err)
	}
	api.mu.Lock()
	s.messages[message.ID] = &apiInput{text: text, done: make(chan struct{})}
	api.mu.Unlock()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = api.Message(ctx, MessageOptions{CallID: s.callID, Message: message})
	var unknown *VoiceInputError
	if !errors.As(err, &unknown) || unknown.Submission != contracts.SubmissionStatusUnknown || !unknown.UnknownOutcome || socket.count("conversation.item.create") != 0 {
		t.Fatal("a cancelled waiter authorized another submission", err)
	}
}

func TestTypedMemoryReferenceUsesTheCapturedCallAndRechecksOwnershipBeforeSending(t *testing.T) {
	for _, changeOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "owned", true: "owner changed"}[changeOwner], func(t *testing.T) {
			api, socket, _ := apiFixture(t, APIOptions{})
			socket.respond = func(event contracts.RawObject) {
				if textField(event, "type") == "conversation.item.create" {
					socket.emit(object(map[string]any{"type": "conversation.item.added", "item": objectField(event, "item")}))
				}
			}
			startAPIFixture(t, api)
			calls := 0
			input := MessageOptions{CallID: "fixture-call", Message: &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Current request"}, MemoryReference: func() string {
				calls++
				if changeOwner {
					api.mu.Lock()
					api.session.inputUnknown = true
					api.mu.Unlock()
				}
				return "Bounded current-input memory reference"
			}}
			result, err := api.Message(t.Context(), input)
			if changeOwner {
				var rejected *VoiceInputError
				if !errors.As(err, &rejected) || rejected.UnknownOutcome || socket.count("conversation.item.create") != 0 {
					t.Fatal("changed call submitted a newly prepared memory reference", err)
				}
			} else if err != nil || result.Submission != contracts.SubmissionStatusConfirmed || socket.count("conversation.item.create") != 1 {
				t.Fatal("owned reference was not submitted exactly once", err)
			}
			if calls != 1 {
				t.Fatal("current-input memory was evaluated more than once")
			}
		})
	}
}
