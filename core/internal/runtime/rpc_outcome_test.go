package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestCancelledRequestCannotWriteAfterItsOwnershipGuardReturns(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		entered := make(chan struct{})
		released := make(chan struct{})
		release := sync.OnceFunc(func() { close(released) })
		t.Cleanup(release)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan error, 1)
		go func() {
			_, err := fixture.client.RequestGuarded(ctx, "turn/start", nil, func() error {
				close(entered)
				<-released
				return nil
			})
			result <- err
		}()
		<-entered
		cancel()
		err := <-result
		var operation *OperationError
		if !errors.As(err, &operation) || operation.UnknownOutcome || !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation did not prove that the guarded request remained unsent")
		}

		release()
		synctest.Wait()
		select {
		case <-fixture.requests:
			t.Fatal("an action was sent after its caller received a known-unsent cancellation")
		default:
		}
	})
}

func TestCancelledQueuedRequestsRepliesAndNotificationsNeverReachTheProvider(t *testing.T) {
	id, err := ParseRPCID(json.RawMessage(`"provider-tool"`))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		send func(context.Context, *RPC) error
	}{
		{
			name: "request",
			send: func(ctx context.Context, rpc *RPC) error {
				_, err := rpc.Request(ctx, "turn/start", nil)
				return err
			},
		},
		{
			name: "reply",
			send: func(ctx context.Context, rpc *RPC) error {
				return rpc.Reply(ctx, id, json.RawMessage(`{"approved":true}`))
			},
		},
		{
			name: "error reply",
			send: func(ctx context.Context, rpc *RPC) error {
				return rpc.ReplyError(ctx, id, -32601, "unsupported")
			},
		},
		{
			name: "notification",
			send: func(ctx context.Context, rpc *RPC) error {
				return rpc.Notify(ctx, "initialized", nil)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newRPCFixture(t)
				entered := make(chan struct{})
				released := make(chan struct{})
				release := sync.OnceFunc(func() { close(released) })
				t.Cleanup(release)
				first := make(chan error, 1)
				go func() {
					_, err := fixture.client.RequestGuarded(context.Background(), "thread/read", nil, func() error {
						close(entered)
						<-released
						return nil
					})
					first <- err
				}()
				<-entered

				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				result := make(chan error, 1)
				go func() { result <- test.send(ctx, fixture.client) }()
				synctest.Wait()
				if len(fixture.client.writes) != 1 {
					t.Fatal("fixture did not queue the frame behind its blocked writer")
				}
				cancel()
				if err := <-result; !errors.Is(err, context.Canceled) {
					t.Fatal("queued frame did not return its cancellation")
				}

				release()
				request := <-fixture.requests
				if string(request["method"]) != `"thread/read"` {
					t.Fatal("a cancelled frame bypassed the held request")
				}
				fixture.send(t, `{"id":1,"result":{}}`)
				if err := <-first; err != nil {
					t.Fatal(err)
				}
				synctest.Wait()
				select {
				case <-fixture.requests:
					t.Fatal("cancelled queued frame was written after returning to its caller")
				default:
				}
			})
		})
	}
}

type observedRPCInput struct {
	io.WriteCloser
	started chan struct{}
	once    sync.Once
}

func (input *observedRPCInput) Write(data []byte) (int, error) {
	input.once.Do(func() { close(input.started) })
	return input.WriteCloser.Write(data)
}

func TestCancellationAfterPhysicalWriteBeginsRemainsUnknown(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		readInput, input := io.Pipe()
		output, writeOutput := io.Pipe()
		observed := &observedRPCInput{WriteCloser: input, started: make(chan struct{})}
		client, err := NewRPC(context.Background(), observed, output, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			client.Close()
			readInput.Close()
			writeOutput.Close()
			<-client.Done()
		})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan error, 1)
		go func() {
			_, err := client.Request(ctx, "turn/start", nil)
			result <- err
		}()
		<-observed.started
		cancel()
		err = <-result
		var operation *OperationError
		if !errors.As(err, &operation) || !operation.UnknownOutcome || !errors.Is(err, context.Canceled) {
			t.Fatal("a write in progress became a safe cancellation to replay")
		}
	})
}

func TestCorrelatedTerminalResultSurvivesImmediateProviderEOF(t *testing.T) {
	for _, test := range []struct {
		name    string
		frame   string
		cause   error
		unknown bool
	}{
		{
			name:  "success",
			frame: `{"id":1,"result":{"turn":{"id":"accepted-turn"}}}`,
		},
		{
			name:  "known rejection",
			frame: `{"id":1,"error":{"code":-1,"message":"private"}}`,
			cause: ErrRequestFailed,
		},
		{
			name:    "malformed rejection",
			frame:   `{"id":1,"error":{"code":null,"message":"private"}}`,
			cause:   ErrInvalidProtocol,
			unknown: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newRPCFixture(t)
				result := make(chan rpcResult, 1)
				go func() {
					object, err := fixture.client.Request(context.Background(), "turn/start", nil)
					result <- rpcResult{object: object, err: err}
				}()
				<-fixture.requests
				fixture.send(t, test.frame)
				fixture.output.Close()
				synctest.Wait()
				response := <-result
				if test.cause == nil {
					if response.err != nil || string(response.object["turn"]) != `{"id":"accepted-turn"}` {
						t.Fatal("transport closure replaced a validated successful response")
					}
					return
				}
				var operation *OperationError
				if !errors.As(response.err, &operation) || !errors.Is(response.err, test.cause) || operation.UnknownOutcome != test.unknown || strings.Contains(response.err.Error(), "private") {
					t.Fatal("transport closure replaced or weakened the correlated rejection")
				}
			})
		})
	}
}

type deadlineBranchContext struct {
	context.Context
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (ctx *deadlineBranchContext) Err() error {
	// Freeze the caller after its real request deadline has selected the
	// failure branch, while allowing the independent reader to settle a reply.
	ctx.once.Do(func() {
		close(ctx.entered)
		<-ctx.release
	})
	return nil
}

func TestSettledResponseWinsAnExpiredDeadlineWithoutClosingOtherRequests(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		ctx := &deadlineBranchContext{
			Context: context.Background(),
			entered: make(chan struct{}),
			release: make(chan struct{}),
		}
		release := sync.OnceFunc(func() { close(ctx.release) })
		t.Cleanup(release)
		first := make(chan rpcResult, 1)
		go func() {
			object, err := fixture.client.Request(ctx, "turn/start", nil)
			first <- rpcResult{object: object, err: err}
		}()
		<-fixture.requests

		// Advance only the isolated synctest clock to the existing production
		// deadline. This adds neither a real delay nor a longer request budget.
		deadline := time.NewTimer(RequestTimeout)
		defer deadline.Stop()
		<-deadline.C
		<-ctx.entered

		second := make(chan rpcResult, 1)
		go func() {
			object, err := fixture.client.Request(context.Background(), "thread/read", nil)
			second <- rpcResult{object: object, err: err}
		}()
		request := <-fixture.requests
		if string(request["id"]) != "2" {
			t.Fatal("later request lost its independent identity")
		}
		fixture.send(t, `{"id":1,"result":{"turn":{"id":"accepted-turn"}}}`)
		synctest.Wait()
		release()
		response := <-first
		if response.err != nil || string(response.object["turn"]) != `{"id":"accepted-turn"}` || fixture.client.Closed() {
			t.Fatal("an expired deadline overrode an already-settled response or closed the shared session")
		}

		fixture.send(t, `{"id":2,"result":{"thread":{"id":"still-current"}}}`)
		response = <-second
		if response.err != nil || string(response.object["thread"]) != `{"id":"still-current"}` {
			t.Fatal("a settled request's deadline rejected another pending operation")
		}
	})
}
