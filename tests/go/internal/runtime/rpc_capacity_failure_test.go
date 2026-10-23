package runtime

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRPCSubscriberCapacityAndOverflowCloseTheTransportWithoutDroppingEvidence(t *testing.T) {
	fixture := newRPCFixture(t)
	for range MaxEventSubscribers {
		_, unsubscribe, err := fixture.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
	}
	if _, _, err := fixture.client.SubscribeEvents(); !errors.Is(err, ErrBackpressure) {
		t.Fatal("subscriber limit was not enforced", err)
	}
	for range RPCEventQueue {
		if !fixture.client.emit(Event{Method: "fixture/observed"}) {
			t.Fatal("bounded event queue closed before capacity")
		}
	}
	if fixture.client.emit(Event{Method: "fixture/overflow"}) || !fixture.client.Closed() || fixture.client.emit(Event{Method: "fixture/late"}) {
		t.Fatal("observer overflow silently dropped execution evidence")
	}
	<-fixture.client.Done()
	if fixture.client.closureReason() != DisconnectEventOverflow {
		t.Fatal("event overflow lost its diagnostic classification")
	}
}

func TestRPCFullWriteQueueRejectsUnsentActionsAndCancellationWithoutRetry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		guard := make(chan struct{})
		first := make(chan error, 1)
		go func() {
			_, err := fixture.client.RequestGuarded(t.Context(), "turn/start", nil, func() error { <-guard; return ErrConnectionChanged })
			first <- err
		}()
		synctest.Wait()
		notifications := make(chan error, RPCWriteQueue)
		for range RPCWriteQueue {
			go func() { notifications <- fixture.client.Notify(t.Context(), "fixture/queued", nil) }()
		}
		synctest.Wait()
		_, err := fixture.client.Request(t.Context(), "turn/start", nil)
		var operation *OperationError
		if !errors.As(err, &operation) || !errors.Is(err, ErrBackpressure) || operation.UnconfirmedOutcome() {
			t.Fatal("never-sent action became an unknown sent operation", err)
		}
		cancelled, cancel := context.WithCancel(t.Context())
		cancel()
		if err := fixture.client.ReplyError(cancelled, NumericRPCID(1), -1, "fixed fixture rejection"); !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled full-queue reply was retried", err)
		}
		if err := fixture.client.Reply(cancelled, NumericRPCID(1), []byte(`{}`)); !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled full-queue result was retried", err)
		}
		fixture.client.Close()
		close(guard)
		if err := <-first; err == nil {
			t.Fatal("closed writer reported a sent success")
		}
		for range RPCWriteQueue {
			if err := <-notifications; err == nil {
				t.Fatal("queued notification reported success without transmission")
			}
		}
		select {
		case _, open := <-fixture.requests:
			if open {
				t.Fatal("rejected queue frame reached the process")
			}
		default:
		}
	})
}

func TestRPCExhaustedIdentityAndMalformedProviderFramesFailClosed(t *testing.T) {
	fixture := newRPCFixture(t)
	fixture.client.mu.Lock()
	fixture.client.next = 9_007_199_254_740_991
	fixture.client.mu.Unlock()
	if _, err := fixture.client.Request(t.Context(), "turn/start", nil); !errors.Is(err, ErrBackpressure) {
		t.Fatal("exhausted safe numeric identifiers wrapped and were reused", err)
	}
	if _, err := fixture.client.queue(t.Context(), contracts.RawObject{"invalid": []byte(`{`)}, new(rpcTransmission), nil); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("invalid wire frame entered the writer", err)
	}
	for _, raw := range []string{`[]`, `{"method":null}`, `{"method":"notice","params":null}`} {
		t.Run(raw, func(t *testing.T) {
			fixture := newRPCFixture(t)
			fixture.send(t, raw)
			<-fixture.client.Done()
			if !fixture.client.Closed() {
				t.Fatal("malformed process frame left execution transport active")
			}
		})
	}
}

func TestMalformedCorrelatedResultIsUnknownAndCannotResolveTheNextRequest(t *testing.T) {
	fixture := newRPCFixture(t)
	first := make(chan error, 1)
	go func() { _, err := fixture.client.Request(t.Context(), "turn/start", nil); first <- err }()
	rpcMethod(t, fixture, "turn/start")
	fixture.send(t, `{"id":true,"result":{}}`)
	fixture.send(t, `{"id":1,"result":[]}`)
	var operation *OperationError
	if err := <-first; !errors.As(err, &operation) || !operation.UnconfirmedOutcome() || !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("invalid correlated result became a known rejection", err)
	}
	next := make(chan error, 1)
	go func() { _, err := fixture.client.Request(t.Context(), "thread/read", nil); next <- err }()
	request := rpcMethod(t, fixture, "thread/read")
	replyFixture(t, fixture, request, `{}`)
	if err := <-next; err != nil {
		t.Fatal("malformed previous result contaminated a separately correlated read", err)
	}
}

func TestSentRPCDeadlineClosesTheConnectionAndRetainsUnknownOutcome(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		done := make(chan error, 1)
		go func() { _, err := fixture.client.Request(t.Context(), "turn/start", nil); done <- err }()
		rpcMethod(t, fixture, "turn/start")
		time.Sleep(RequestTimeout + time.Millisecond)
		var operation *OperationError
		if err := <-done; !errors.As(err, &operation) || !operation.UnconfirmedOutcome() || !errors.Is(err, ErrRequestTimeout) || !fixture.client.Closed() {
			t.Fatal("unacknowledged deadline authorized replay", err)
		}
	})
}
