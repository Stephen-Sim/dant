package voice

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestCallEndIsDurableOnceForExplicitAndSpontaneousMediaClose(t *testing.T) {
	for _, spontaneous := range []bool{false, true} {
		t.Run(map[bool]string{true: "spontaneous", false: "explicit"}[spontaneous], func(t *testing.T) {
			ctx := context.Background()
			persistence, err := store.Open(t.TempDir(), store.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer persistence.Close()
			api, socket, _ := apiFixture(t, APIOptions{})
			var now atomic.Int64
			now.Store(10000)
			var continued, cancelled atomic.Int32
			continuedDone := make(chan struct{}, 1)
			service := NewService(ServiceOptions{API: api, History: persistence, Reservations: &serviceReservation{reserved: make(chan struct{})}, Now: func() time.Time { return time.UnixMilli(now.Load()) }, ContinueVoiceTasks: func(_ context.Context, id string) error {
				if id != "call-one" {
					t.Error("call owner changed")
				}
				continued.Add(1)
				select {
				case continuedDone <- struct{}{}:
				default:
				}
				return nil
			}, CancelOwner: func(context.Context, string) error { cancelled.Add(1); return nil }})
			if _, err = service.StartCall(ctx, CallStartRequest{SDP: fixtureSDP, Provider: "api", CallID: "call-one"}); err != nil {
				t.Fatal(err)
			}
			if _, err = service.ConfirmConnected("call-one"); err != nil {
				t.Fatal(err)
			}
			now.Store(14000)
			if _, err = service.ConfirmConnected("call-one"); err != nil {
				t.Fatal(err)
			}
			if spontaneous {
				_ = socket.Close()
				waitVoice(t, func() bool { return service.Snapshot() == nil })
			} else if err = service.Stop(ctx, "call-one"); err != nil {
				t.Fatal(err)
			}
			if err = service.Stop(ctx, "call-one"); err != nil {
				t.Fatal(err)
			}
			completed, cancel := context.WithTimeout(ctx, callLifecycleIOTimeout)
			defer cancel()
			select {
			case <-continuedDone:
			case <-completed.Done():
				t.Fatal("call lifecycle did not finish within its bounded I/O budget")
			}
			state := persistence.Snapshot()
			if continued.Load() != 1 || len(state.Messages) != 1 || state.Messages[0].Kind != "call" || state.Messages[0].CallID != "call-one" || cancelled.Load() != 0 {
				t.Fatal("call end duplicated history or cancelled accepted work")
			}
			seconds, _ := state.Messages[0].Seconds.Get()
			if seconds != 4 {
				t.Fatal("repeat connected acknowledgement reset call duration")
			}
		})
	}
}

func TestCallEndCannotWriteIntoNewConversationAndShutdownCancelsOnlyItsOwner(t *testing.T) {
	ctx := context.Background()
	native, _, _, persistence := nativeFixture(t)
	var continued, cancelled atomic.Int32
	service := NewService(ServiceOptions{Native: native, History: persistence, ContinueVoiceTasks: func(context.Context, string) error { continued.Add(1); return nil }, CancelOwner: func(_ context.Context, id string) error {
		if id != "call-one" {
			t.Error("wrong cancellation owner")
		}
		cancelled.Add(1)
		return nil
	}})
	if _, err := service.StartCall(ctx, CallStartRequest{SDP: fixtureSDP, CallID: "call-one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ConfirmConnected("call-one"); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Mutate(ctx, func(state *contracts.State) error {
		state.ConversationID = "00000000-0000-4000-8000-000000000002"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if len(persistence.Snapshot().Messages) != 0 || continued.Load() != 0 || cancelled.Load() != 1 {
		t.Fatal("late call close crossed conversation or work ownership")
	}
}

func TestCallHistoryFailureDoesNotRepeatLifecycleSideEffects(t *testing.T) {
	service := NewService(ServiceOptions{ContinueVoiceTasks: func(context.Context, string) error { return errors.New("fixture failure") }})
	if err := service.rememberCall(CallStartRequest{CallID: "one", Provider: "api"}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := service.ended(context.Background(), EndedEvent{CallID: "one", Provider: "api", Reason: CallEndUser}); !errors.Is(err, ErrCallLifecycle) {
			t.Fatal("failed lifecycle was silently accepted")
		}
	}
}
