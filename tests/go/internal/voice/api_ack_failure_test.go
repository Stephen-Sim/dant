package voice

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPITypedInputAndContextRejectOnlyTheirCorrelatedProviderErrors(t *testing.T) {
	api, socket, _ := apiFixture(t, APIOptions{})
	socket.respond = func(event contracts.RawObject) {
		if kind := textField(event, "type"); kind == "conversation.item.create" || kind == "session.update" {
			socket.emit(contracts.RawObject{"type": rawValue("error"), "error": rawValue(contracts.RawObject{"event_id": event["event_id"], "code": rawValue("invalid_request_error")})})
		}
	}
	startAPIFixture(t, api)
	message := &contracts.ChatMessage{ID: "rejected-input", Role: contracts.RoleUser, Text: "Synthetic typed request"}
	if _, err := api.Message(t.Context(), MessageOptions{CallID: "fixture-call", Message: message}); err == nil {
		t.Fatal("explicit provider rejection was treated as a confirmed input")
	} else {
		var rejected *VoiceInputError
		if !errors.As(err, &rejected) || rejected.Submission != contracts.SubmissionStatusRejected || rejected.UnknownOutcome || rejected.Error() == "" {
			t.Fatal("provider rejection lost its confirmed unsuccessful classification", err)
		}
	}
	result := api.SyncContext(t.Context(), "fixture-call", "message", &contracts.ChatMessage{ID: "rejected-reference", Role: contracts.RoleAssistant, Text: "Synthetic shared result"})
	if result.Status != contracts.LiveContextStatusFailed {
		t.Fatal("rejected live reference was committed as submitted", result)
	}
	api.mu.Lock()
	committed := len(api.session.contextEntries)
	api.mu.Unlock()
	if committed != 0 || socket.count("conversation.item.create") != 1 || socket.count("session.update") != 1 {
		t.Fatal("rejected input or context was committed or retried")
	}
}

func TestAPIShutdownReleasesPendingInputAndContextAcknowledgementsOnce(t *testing.T) {
	api, socket, hangups := apiFixture(t, APIOptions{})
	writes := make(chan string, 2)
	socket.respond = func(event contracts.RawObject) {
		kind := textField(event, "type")
		if kind == "conversation.item.create" || kind == "session.update" {
			writes <- kind
		}
	}
	startAPIFixture(t, api)
	inputDone := make(chan error, 1)
	contextDone := make(chan ContextResult, 1)
	go func() {
		_, err := api.Message(t.Context(), MessageOptions{CallID: "fixture-call", Message: &contracts.ChatMessage{ID: "pending-shutdown-input", Role: contracts.RoleUser, Text: "Synthetic unacknowledged input"}})
		inputDone <- err
	}()
	go func() { contextDone <- api.SyncMemory(t.Context(), "fixture-call", "Synthetic unacknowledged memory") }()
	for range 2 {
		<-writes
	}
	if err := api.Close(t.Context()); err != nil {
		t.Fatal("shutdown failed to join cancelled acknowledgement waiters", err)
	}
	if err := <-inputDone; err == nil {
		t.Fatal("unacknowledged input claimed successful delivery during shutdown")
	}
	if result := <-contextDone; result.Status == contracts.LiveContextStatusSubmitted {
		t.Fatal("unacknowledged context became submitted during shutdown")
	}
	if api.Snapshot().Call != nil || hangups.Load() != 1 {
		t.Fatal("shutdown duplicated its media hangup or retained active media")
	}
}

func TestAPILiveContextRetainsIndependentKeysWhenReplacingOneSnapshot(t *testing.T) {
	api, socket, _ := apiFixture(t, APIOptions{})
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "session.update" {
			socket.emit(contracts.RawObject{"type": rawValue("session.updated"), "session": event["session"]})
		}
	}
	startAPIFixture(t, api)
	for _, input := range []struct{ id, text string }{{"first", "Old snapshot"}, {"second", "Independent snapshot"}, {"first", "Replacement snapshot"}} {
		result := api.SyncContext(t.Context(), "fixture-call", "message", &contracts.ChatMessage{ID: input.id, Role: contracts.RoleAssistant, Text: input.text})
		if result.Status != contracts.LiveContextStatusSubmitted {
			t.Fatal("owned live snapshot was not acknowledged", result)
		}
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if len(api.session.contextOrder) != 2 || api.session.contextOrder[0] != "message:second" || api.session.contextOrder[1] != "message:first" || len(api.session.contextEntries) != 2 {
		t.Fatal("replacing one reference deleted unrelated context or duplicated the stale snapshot")
	}
}

func TestAPIPreSubmissionLifecycleChangesCannotActivateLateMedia(t *testing.T) {
	for _, phase := range []string{"key read", "context override", "sideband dial"} {
		t.Run(phase, func(t *testing.T) {
			api, socket, _ := apiFixture(t, APIOptions{})
			input := APIStart{SDP: fixtureSDP, CallID: "cancelled-start-call"}
			switch phase {
			case "key read":
				api.options.GetKey = func(context.Context) (string, error) {
					api.mu.Lock()
					api.session.cancel()
					api.mu.Unlock()
					return fixtureVoiceKey, nil
				}
			case "context override":
				reference := "Synthetic explicit chat context"
				input.Context = &reference
			case "sideband dial":
				api.options.Dial = func(ctx context.Context, _, _ string) (VoiceSocket, error) {
					if err := api.Stop(ctx, "user"); err != nil {
						t.Error("concurrent stop failed", err)
					}
					return socket, nil
				}
			}
			_, err := api.Start(t.Context(), input)
			if phase == "context override" {
				if err != nil {
					t.Fatal("explicit captured context was ignored", err)
				}
			} else if !errors.Is(err, ErrVoiceCancelled) || api.Snapshot().Call != nil {
				t.Fatal("late provider setup activated media after its owner ended", err)
			}
			if err := api.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := api.Stop(t.Context(), "user"); err != nil {
				t.Fatal("already retired media could not be stopped idempotently", err)
			}
			api.fail(nil, context.Canceled)
		})
	}
}
