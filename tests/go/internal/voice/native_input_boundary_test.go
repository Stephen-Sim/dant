package voice

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestNativeTypedInputRejectsInvalidIdentityScopeAndMissingQuoteBeforeAppending(t *testing.T) {
	for _, kind := range []string{"invalid client", "blank text", "cancelled intake", "deleted client", "missing call", "missing quote", "changed duplicate", "failed persistence"} {
		t.Run(kind, func(t *testing.T) {
			native, worker, _, persistence := nativeFixture(t)
			startNativeFixture(t, native)
			input := NativeMessage{CallID: "call-one", ClientMessageID: "client", Text: "Authored input"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch kind {
			case "invalid client":
				input.ClientMessageID = "invalid client"
			case "blank text":
				input.Text = " "
			case "cancelled intake":
				native.intake <- struct{}{}
				defer func() { <-native.intake }()
				cancel()
			case "deleted client":
				if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
					state.DeletedClientMessageIDs = []string{input.ClientMessageID}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			case "missing call":
				input.CallID = "foreign"
			case "missing quote":
				quote := "missing"
				input.ReplyTo = &quote
			case "changed duplicate":
				if _, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "existing", Role: contracts.RoleUser, Text: "Different authored request", ClientMessageID: input.ClientMessageID, VoiceCallID: input.CallID}); err != nil {
					t.Fatal(err)
				}
			case "failed persistence":
				persistence.Close()
			}
			if _, err := native.Message(ctx, input); err == nil || worker.appendCalls.Load() != 0 {
				t.Fatal("invalid typed input was appended to the realtime thread", kind, err)
			}
		})
	}
}

func TestNativeCallSubmissionKeepsPersistedUncertaintyAndRejectsUnavailableOwners(t *testing.T) {
	for _, kind := range []string{"invalid message", "missing saved", "foreign call", "already confirmed", "unknown submission", "unknown call", "paused call", "missing reference", "unknown reference", "closed during reference", "provider rejected"} {
		t.Run(kind, func(t *testing.T) {
			native, worker, _, persistence := nativeFixture(t)
			startNativeFixture(t, native)
			message, err := persistence.Add(t.Context(), &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Current request"})
			if err != nil {
				t.Fatal(err)
			}
			callID := "call-one"
			switch kind {
			case "invalid message":
				message = nil
			case "missing saved":
				message.ID = "missing"
			case "foreign call":
				callID = "foreign"
			case "already confirmed", "unknown submission":
				submission := contracts.SubmissionStatusConfirmed
				if kind == "unknown submission" {
					submission = contracts.SubmissionStatusUnknown
				}
				if _, err := persistence.Update(t.Context(), message.ID, contracts.MessagePatch{"submission": rawValue(submission)}); err != nil {
					t.Fatal(err)
				}
			case "unknown call", "paused call":
				native.mu.Lock()
				if kind == "unknown call" {
					native.session.unknown = true
				} else {
					native.session.pausing = true
				}
				native.mu.Unlock()
			case "missing reference":
				native.options.RememberCallInput = nil
			case "unknown reference":
				native.options.RememberCallInput = func(context.Context, *contracts.ChatMessage, string) error {
					return &VoiceInputError{Code: "fixture_reference_unknown", Submission: contracts.SubmissionStatusUnknown, UnknownOutcome: true}
				}
			case "closed during reference":
				native.options.RememberCallInput = func(context.Context, *contracts.ChatMessage, string) error { persistence.Close(); return nil }
			case "provider rejected":
				worker.mu.Lock()
				worker.appendError = &runtime.OperationError{Cause: runtime.ErrRequestFailed}
				worker.mu.Unlock()
			}
			_, err = native.SubmitCallMessage(t.Context(), callID, message)
			if err == nil {
				t.Fatal("invalid or unconfirmed call submission returned success", kind)
			}
			if kind == "provider rejected" {
				state := persistence.Snapshot()
				if state.Messages[0].Submission.Value != contracts.SubmissionStatusRejected || state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || worker.appendCalls.Load() != 1 {
					t.Fatal("explicit rejection became a retriable or confirmed action")
				}
			} else if worker.appendCalls.Load() != 0 {
				t.Fatal("unavailable owner reached realtime append", kind)
			}
			if kind == "unknown reference" {
				var unknown *VoiceInputError
				if !errors.As(err, &unknown) || !unknown.UnknownOutcome || persistence.Snapshot().Messages[0].Submission.Value != contracts.SubmissionStatusUnknown {
					t.Fatal("unconfirmed durable reference became safe to resubmit", err)
				}
			}
		})
	}
}

func TestNativeContextQueueCreationAndThreadFailuresNeverBecomeSubmitted(t *testing.T) {
	for _, kind := range []string{"invalid queue", "missing thread"} {
		t.Run(kind, func(t *testing.T) {
			native, worker, _, _ := nativeFixture(t)
			startNativeFixture(t, native)
			if kind == "invalid queue" {
				native.options.ContextTimeout = time.Nanosecond
			} else {
				native.mu.Lock()
				native.session.threadID = ""
				native.mu.Unlock()
			}
			if result := native.SyncMemory(t.Context(), "call-one", "reference"); result.Status != contracts.LiveContextStatusFailed || worker.appendCalls.Load() != 0 {
				t.Fatal("invalid queue or missing thread accepted shared memory")
			}
			if result := native.SyncContext(t.Context(), "call-one", "message", &contracts.ChatMessage{ID: "reference", Role: contracts.RoleAssistant, Text: "Existing result"}); result.Status != contracts.LiveContextStatusFailed || worker.appendCalls.Load() != 0 {
				t.Fatal("invalid queue or missing thread accepted a message reference")
			}
		})
	}
}
