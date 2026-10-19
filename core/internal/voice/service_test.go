package voice

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type serviceReservation struct {
	mu       sync.Mutex
	current  bool
	reserved chan struct{}
	released bool
}

func (fixture *serviceReservation) ReserveCallStart(context.Context, string, string) (work.CallStartReservation, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.current = true
	close(fixture.reserved)
	return work.CallStartReservation{Token: "fixture-reservation"}, nil
}

func (fixture *serviceReservation) CallStartCurrent(work.CallStartReservation) bool {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.current
}

func (fixture *serviceReservation) ReleaseCallStart(work.CallStartReservation) {
	fixture.mu.Lock()
	fixture.released = true
	fixture.current = false
	fixture.mu.Unlock()
}

func TestServiceAPIReservationPrecedesContextAndRejectsChangedOwner(t *testing.T) {
	api, _, hangups := apiFixture(t, APIOptions{})
	reservation := &serviceReservation{reserved: make(chan struct{})}
	service := NewService(ServiceOptions{
		API:          api,
		Reservations: reservation,
		Memory: func(context.Context) (string, error) {
			select {
			case <-reservation.reserved:
			default:
				t.Fatal("API context ran without execution reservation")
			}
			reservation.mu.Lock()
			reservation.current = false
			reservation.mu.Unlock()
			return "context", nil
		},
	})
	_, err := service.StartCall(context.Background(), CallStartRequest{Provider: "api", CallID: "call-one", SDP: fixtureSDP})
	if !errors.Is(err, ErrVoiceCancelled) || api.Snapshot().Call != nil || hangups.Load() != 0 {
		t.Fatal("stale reservation created a remote call", err)
	}
	reservation.mu.Lock()
	defer reservation.mu.Unlock()
	if !reservation.released {
		t.Fatal("start reservation leaked")
	}
}

func TestServiceSnapshotAndHangupDoNotAcquireEngineLock(t *testing.T) {
	native, _, engine, _ := nativeFixture(t)
	startNativeFixture(t, native)
	service := NewService(ServiceOptions{Native: native})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		for index := 0; index < 100; index++ {
			_ = service.Snapshot()
			_ = service.PendingWork()
		}
		close(finished)
	}()
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("snapshot inverted Engine and voice ownership locks")
	}
	if err := service.Stop(ctx, "call-one"); err != nil || engine.paused.Load() != 0 {
		t.Fatal("hangup changed work ownership", err)
	}
	if err := service.AttachReservations(&serviceReservation{}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Message(ctx, MessageOptions{CallID: "call-one", Message: &contracts.ChatMessage{Role: contracts.RoleUser, Text: "late"}}); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("ended call input fell through", err)
	}
}
