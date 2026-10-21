package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAbandonedTransmissionCannotReachTheExecutorWithAnActiveCallerContext(t *testing.T) {
	fixture := newRPCFixture(t)
	gate, entered := make(chan struct{}), make(chan struct{})
	transmission := new(rpcTransmission)
	ack, err := fixture.client.queue(t.Context(), contracts.RawObject{"method": json.RawMessage(`"fixture/retired"`), "params": json.RawMessage(`{}`)}, transmission, func() error {
		close(entered)
		<-gate
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if transmission.abandon() {
		t.Fatal("never-started queued frame acquired an unknown sent outcome")
	}
	close(gate)
	if err := <-ack; !errors.Is(err, ErrDisconnected) {
		t.Fatal("retired transmission was reported sent", err)
	}

	if err := fixture.client.Notify(t.Context(), "fixture/current", nil); err != nil {
		t.Fatal("discarding a retired frame corrupted its still-active connection", err)
	}
	request := <-fixture.requests
	if string(request["method"]) != `"fixture/current"` {
		t.Fatal("a retired frame reached the executor before the current notification")
	}
}

func TestResponseCapturedBeforeCancellationCannotSettleARetiredRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		gate := make(chan struct{})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := fixture.client.RequestGuarded(ctx, "thread/read", nil, func() error {
				<-gate
				return nil
			})
			done <- err
		}()
		synctest.Wait()
		fixture.client.mu.Lock()
		captured := fixture.client.pending["n:1"]
		fixture.client.mu.Unlock()
		if captured == nil {
			t.Fatal("fixture request did not register its owned pending identity")
		}

		cancel()
		var operation *OperationError
		if err := <-done; !errors.Is(err, context.Canceled) || !errors.As(err, &operation) || operation.UnconfirmedOutcome() {
			t.Fatal("queued request cancellation invented a sent outcome", err)
		}
		fixture.client.settle("n:1", captured, rpcResult{object: contracts.RawObject{"late": json.RawMessage(`true`)}})
		select {
		case <-captured.result:
			t.Fatal("response captured before cancellation revived a retired request")
		default:
		}
		close(gate)
		synctest.Wait()
	})
}
