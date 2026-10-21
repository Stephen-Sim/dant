package voice

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestContextQueueRejectsInvalidConfigurationAndReportsInvalidOrStaleInputs(t *testing.T) {
	for _, kind := range []string{"call", "send", "current", "short timeout", "long timeout", "negative limit", "large limit"} {
		t.Run(kind, func(t *testing.T) {
			options := ContextQueueOptions{CallID: "call", IsCurrent: func() bool { return true }, Send: func(context.Context, ContextInput) error { return nil }}
			switch kind {
			case "call":
				options.CallID = ""
			case "send":
				options.Send = nil
			case "current":
				options.IsCurrent = nil
			case "short timeout":
				options.Timeout = time.Nanosecond
			case "long timeout":
				options.Timeout = 31 * time.Second
			case "negative limit":
				options.MaxPending = -1
			case "large limit":
				options.MaxPending = 33
			}
			if _, err := NewContextQueue(t.Context(), options); !errors.Is(err, ErrCallInput) {
				t.Fatal("invalid queue configuration created a background owner", err)
			}
		})
	}
	current, sends := true, 0
	queue, err := NewContextQueue(t.Context(), ContextQueueOptions{
		CallID: "call", IsCurrent: func() bool { return current },
		Send:     func(context.Context, ContextInput) error { sends++; return nil },
		OnResult: func(ContextResult) { panic("isolated consumer failure") },
	})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if result := queue.Enqueue(cancelled, ContextInput{Text: "cancelled"}); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("pre-cancelled input entered a live submission")
	}
	if result := queue.Enqueue(t.Context(), ContextInput{}); result.Status != contracts.LiveContextStatusFailed {
		t.Fatal("empty context was submitted")
	}
	current = false
	if result := queue.Enqueue(t.Context(), ContextInput{Text: "stale"}); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("stale call input was submitted")
	}
	if err := queue.Close(t.Context()); err != nil || sends != 0 {
		t.Fatal("unused queue failed to join", err)
	}
	if result := queue.Enqueue(t.Context(), ContextInput{Text: "closed"}); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("closed queue accepted another input")
	}
}

func TestContextQueueReplacesOnlyMatchingPendingKeysAndEnforcesItsBound(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		var sent []string
		queue, err := NewContextQueue(t.Context(), ContextQueueOptions{
			CallID: "call", MaxPending: 1, IsCurrent: func() bool { return true },
			Send: func(_ context.Context, input ContextInput) error {
				sent = append(sent, input.Text)
				if input.Key == "active" {
					<-gate
				}
				return nil
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		first, old, latest := make(chan ContextResult, 1), make(chan ContextResult, 1), make(chan ContextResult, 1)
		go func() { first <- queue.Enqueue(t.Context(), ContextInput{Key: "active", Text: "first"}) }()
		synctest.Wait()
		go func() { old <- queue.Enqueue(t.Context(), ContextInput{Key: "replace", Text: "old"}) }()
		synctest.Wait()
		go func() { latest <- queue.Enqueue(t.Context(), ContextInput{Key: "replace", Text: "latest"}) }()
		synctest.Wait()
		if result := <-old; result.Status != contracts.LiveContextStatusSuperseded {
			t.Fatal("replaced pending context was reported as submitted")
		}
		if result := queue.Enqueue(t.Context(), ContextInput{Key: "overflow", Text: "extra"}); result.Status != contracts.LiveContextStatusFailed {
			t.Fatal("pending bound accepted another distinct context")
		}
		close(gate)
		if (<-first).Status != contracts.LiveContextStatusSubmitted || (<-latest).Status != contracts.LiveContextStatusSubmitted || len(sent) != 2 || sent[0] != "first" || sent[1] != "latest" {
			t.Fatal("queue submitted superseded data or reordered retained contexts")
		}
		if err := queue.Close(t.Context()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestUnconfirmedContextCancelsAllAutomaticFollowingSubmissions(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		sends := 0
		queue, err := NewContextQueue(t.Context(), ContextQueueOptions{
			CallID: "call", IsCurrent: func() bool { return true },
			Send: func(context.Context, ContextInput) error { sends++; <-gate; return ErrContextUnknown },
		})
		if err != nil {
			t.Fatal(err)
		}
		first, pending := make(chan ContextResult, 1), make(chan ContextResult, 1)
		go func() { first <- queue.Enqueue(t.Context(), ContextInput{Key: "first", Text: "first"}) }()
		synctest.Wait()
		go func() { pending <- queue.Enqueue(t.Context(), ContextInput{Key: "next", Text: "next"}) }()
		synctest.Wait()
		close(gate)
		if (<-first).Status != contracts.LiveContextStatusUnknown || (<-pending).Status != contracts.LiveContextStatusUnknown || sends != 1 {
			t.Fatal("unknown context outcome allowed a following submission")
		}
		if err := queue.Close(t.Context()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestChangedCallAndQueueShutdownCancelPendingContextsAndJoinActiveSend(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "close", true: "call changed"}[changed], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				gate := make(chan struct{})
				var current atomic.Bool
				current.Store(true)
				sends := 0
				queue, err := NewContextQueue(t.Context(), ContextQueueOptions{
					CallID: "call", IsCurrent: current.Load,
					Send: func(ctx context.Context, _ ContextInput) error {
						sends++
						select {
						case <-ctx.Done():
							return ctx.Err()
						case <-gate:
							return nil
						}
					},
				})
				if err != nil {
					t.Fatal(err)
				}
				first, next := make(chan ContextResult, 1), make(chan ContextResult, 1)
				go func() { first <- queue.Enqueue(t.Context(), ContextInput{Key: "active", Text: "first"}) }()
				synctest.Wait()
				go func() { next <- queue.Enqueue(t.Context(), ContextInput{Key: "pending", Text: "next"}) }()
				synctest.Wait()
				if changed {
					current.Store(false)
					close(gate)
				} else if err := queue.Close(t.Context()); err != nil {
					t.Fatal(err)
				}
				if (<-first).Status != contracts.LiveContextStatusCancelled || (<-next).Status != contracts.LiveContextStatusCancelled || sends != 1 {
					t.Fatal("changed or closed call submitted its queued context")
				}
				if err := queue.Close(t.Context()); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestCallerCancellationAndUnjoinedCloseRemainExplicitlyUnknown(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		queue, err := NewContextQueue(t.Context(), ContextQueueOptions{CallID: "call", IsCurrent: func() bool { return true }, Send: func(context.Context, ContextInput) error { <-gate; return nil }})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		result := make(chan ContextResult, 1)
		go func() { result <- queue.Enqueue(ctx, ContextInput{Text: "active"}) }()
		synctest.Wait()
		cancel()
		if (<-result).Status != contracts.LiveContextStatusUnknown {
			t.Fatal("caller cancellation proved that an active submission was unsent")
		}
		cancelled, stop := context.WithCancel(t.Context())
		stop()
		if err := queue.Close(cancelled); !errors.Is(err, ErrContextUnknown) {
			t.Fatal("uncooperative active send was reported joined", err)
		}
		close(gate)
		if err := queue.Close(t.Context()); err != nil {
			t.Fatal("released send did not join its owned queue", err)
		}
	})
}
