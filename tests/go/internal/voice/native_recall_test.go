package voice

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestSubscriptionServicePreservesCapturedMemoryReference(t *testing.T) {
	native, worker, _, persistence := nativeFixture(t)
	startNativeFixture(t, native)
	native.options.MemoryReference = func(context.Context, *contracts.ChatMessage) (string, error) {
		t.Fatal("captured chat recall was replaced with another retrieval")
		return "", nil
	}
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "Fixture follow-up", VoiceCallID: "call-one",
		Submission: contracts.Some(contracts.SubmissionStatusPreparing),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(ServiceOptions{Native: native})
	result, err := service.Message(context.Background(), MessageOptions{
		CallID: "call-one", Message: message, IsCurrent: func() bool { return true },
		MemoryReference: func() string { return "Captured scoped recall" },
	})
	if err != nil || result.Submission != contracts.SubmissionStatusConfirmed {
		t.Fatal("subscription input was not acknowledged", err)
	}
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if len(worker.appended) != 1 || !strings.HasSuffix(worker.appended[0], "\n\nCaptured scoped recall") {
		t.Fatal("subscription discarded the captured memory context")
	}
}

func TestNativeRecallFailureOrCancellationIsNotSubmitted(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "cancelled"}[cancelled], func(t *testing.T) {
			native, worker, _, persistence := nativeFixture(t)
			startNativeFixture(t, native)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			remembered := false
			native.options.RememberCallInput = func(context.Context, *contracts.ChatMessage, string) error {
				remembered = true
				return nil
			}
			native.options.MemoryReference = func(inputContext context.Context, message *contracts.ChatMessage) (string, error) {
				if message.ID == "" || inputContext != ctx {
					t.Fatal("retrieval lost the request or message identity")
				}
				if cancelled {
					cancel()
					return "Late recall", nil
				}
				return "", errors.New("fixture unavailable")
			}
			_, err := native.Message(ctx, NativeMessage{ClientMessageID: "recall-input", CallID: "call-one", Text: "Fixture request"})
			var failure *VoiceInputError
			if !errors.As(err, &failure) || failure.Submission != contracts.SubmissionStatusNotSubmitted || failure.UnknownOutcome {
				t.Fatal("failed recall was not a known unsubmitted result", err)
			}
			if remembered || worker.appendCalls.Load() != 0 {
				t.Fatal("failed recall injected or dispatched typed input")
			}
			messages := persistence.Snapshot().Messages
			if len(messages) != 1 {
				t.Fatal("failed recall lost its durable input")
			}
			status, _ := messages[0].Status.Get()
			if status != contracts.MessageStatus(contracts.TaskStatusPaused) {
				t.Fatal("failed recall left input eligible for automatic dispatch")
			}
		})
	}
}
