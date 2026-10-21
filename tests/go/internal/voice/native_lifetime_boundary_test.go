package voice

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestNativeRemoteClosureClearsCaptionsAndJoinsAutomaticMediaRetirement(t *testing.T) {
	native, _, _, _ := nativeFixture(t)
	captions := make(chan Caption, 4)
	native.options.Subtitle = func(caption Caption) { captions <- caption }
	startNativeFixture(t, native)
	if err := native.HandleEvent(t.Context(), runtime.Event{Method: "thread/realtime/transcript/delta", Params: contracts.RawObject{"threadId": rawValue("shared-thread"), "role": rawValue("assistant"), "delta": rawValue("Synthetic native caption")}}); err != nil {
		t.Fatal(err)
	}
	if caption := <-captions; caption.Text != "Synthetic native caption" || caption.CallID != "call-one" {
		t.Fatal("native provider caption lost its exact media owner")
	}
	if err := native.HandleEvent(t.Context(), runtime.Event{Method: "thread/realtime/closed", Params: contracts.RawObject{"threadId": rawValue("shared-thread")}}); err != nil {
		t.Fatal(err)
	}
	if caption := <-captions; caption.Text != "" {
		t.Fatal("remote media closure retained stale assistant captions")
	}
	waitVoice(t, func() bool { return native.Call() == nil })
	if err := native.Close(t.Context()); err != nil {
		t.Fatal("automatic native retirement did not join its event owners", err)
	}
}

func TestNativeInputWaitersShareOneDurableSubmissionWithoutReplayingIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		native, worker, _, persistence := nativeFixture(t)
		entered, release := make(chan struct{}), make(chan struct{})
		var remembered atomic.Int32
		native.options.RememberCallInput = func(ctx context.Context, _ *contracts.ChatMessage, _ string) error {
			remembered.Add(1)
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		startNativeFixture(t, native)
		message, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "Synthetic shared input"})
		if err != nil {
			t.Fatal(err)
		}
		input := MessageOptions{CallID: "call-one", Message: message}
		first := make(chan NativeMessageResult, 1)
		failures := make(chan error, 2)
		go func() { result, err := native.SubmitMessage(t.Context(), input); first <- result; failures <- err }()
		<-entered
		cancelled, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := native.SubmitMessage(cancelled, input); err == nil {
			t.Fatal("cancelled waiter claimed another caller's pending receipt")
		} else {
			var unknown *VoiceInputError
			if !errors.As(err, &unknown) || !unknown.UnknownOutcome {
				t.Fatal("cancelled pending waiter was mislabeled as safely unsent", err)
			}
		}
		second := make(chan NativeMessageResult, 1)
		go func() { result, err := native.SubmitMessage(t.Context(), input); second <- result; failures <- err }()
		synctest.Wait()
		close(release)
		left, right := <-first, <-second
		for range 2 {
			if err := <-failures; err != nil {
				t.Fatal("shared native input did not retain one confirmed receipt", err)
			}
		}
		if left.Message.ID != right.Message.ID || left.Submission != contracts.SubmissionStatusConfirmed || right.Submission != contracts.SubmissionStatusConfirmed || remembered.Load() != 1 || worker.appendCalls.Load() != 1 {
			t.Fatal("concurrent receipt waiters replayed input or replaced its durable message")
		}
		if err := native.Close(t.Context()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestNativeQuotedMessageDeduplicationIncludesTheExactQuoteIdentity(t *testing.T) {
	native, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, native)
	quoted, err := persistence.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "Synthetic quoted result"})
	if err != nil {
		t.Fatal(err)
	}
	input := NativeMessage{CallID: "call-one", ClientMessageID: "quoted-deduplicated-input", Text: "Explain this", ReplyTo: &quoted.ID}
	first, err := native.Message(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := native.Message(t.Context(), input)
	if err != nil || !second.Duplicate || second.Message.ID != first.Message.ID || worker.appendCalls.Load() != 1 {
		t.Fatal("same quoted client input did not reuse its exact confirmed receipt", err)
	}
	if err := native.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}
