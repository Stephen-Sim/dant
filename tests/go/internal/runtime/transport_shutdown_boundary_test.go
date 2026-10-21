package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRetiredReadResponseCannotTransmitItsStillQueuedFrame(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		gate := make(chan struct{})
		done := make(chan rpcResult, 1)
		go func() {
			object, err := fixture.client.RequestGuarded(t.Context(), "thread/read", nil, func() error {
				<-gate
				return nil
			})
			done <- rpcResult{object: object, err: err}
		}()
		synctest.Wait()

		fixture.send(t, `{"id":1,"result":{"thread":{"id":"isolated-thread"}}}`)
		response := <-done
		if response.err != nil || response.object["thread"] == nil {
			t.Fatal("correlated read response was lost", response.err)
		}
		close(gate)
		synctest.Wait()

		select {
		case request := <-fixture.requests:
			t.Fatal("retired request was transmitted after its response", request)
		default:
		}
	})
}

func TestQueuedProviderRepliesObserveTransportClosureWithoutTransmission(t *testing.T) {
	for _, errorReply := range []bool{false, true} {
		t.Run(map[bool]string{false: "result", true: "error"}[errorReply], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newRPCFixture(t)
				gate := make(chan struct{})
				blocked := make(chan error, 1)
				go func() {
					_, err := fixture.client.RequestGuarded(t.Context(), "thread/read", nil, func() error {
						<-gate
						return ErrConnectionChanged
					})
					blocked <- err
				}()
				synctest.Wait()

				replied := make(chan error, 1)
				go func() {
					if errorReply {
						replied <- fixture.client.ReplyError(t.Context(), NumericRPCID(21), -1, "fixed fixture rejection")
						return
					}
					replied <- fixture.client.Reply(t.Context(), NumericRPCID(21), json.RawMessage(`{}`))
				}()
				synctest.Wait()

				fixture.client.Close()
				if err := <-replied; !errors.Is(err, ErrDisconnected) {
					t.Fatal("queued reply succeeded on a closed transport", err)
				}
				if err := fixture.client.Notify(t.Context(), "fixture/late", nil); !errors.Is(err, ErrDisconnected) {
					t.Fatal("closed transport accepted a later notification", err)
				}
				close(gate)
				if err := <-blocked; err == nil {
					t.Fatal("blocked request succeeded during transport closure")
				}
				<-fixture.client.Done()
			})
		})
	}
}

func TestProviderEventOverflowRetiresTheReaderAndItsSubscribers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		events, unsubscribe, err := fixture.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()

		for range RPCEventQueue + 1 {
			fixture.send(t, `{"method":"fixture/observed","params":{}}`)
		}
		<-fixture.client.Done()
		count := 0
		for range events {
			count++
		}
		if count != RPCEventQueue || !fixture.client.Closed() {
			t.Fatal("reader overflow silently discarded evidence without retiring the session", count)
		}
	})
}

type rejectInitializedInput struct{ io.WriteCloser }

func (input rejectInitializedInput) Write(data []byte) (int, error) {
	object, err := contracts.DecodeObject(data, MaxRPCFrameBytes)
	if err != nil {
		return 0, err
	}
	if string(object["method"]) == `"initialized"` {
		return 0, io.ErrClosedPipe
	}
	return input.WriteCloser.Write(data)
}

func TestWorkerInitializationNotificationFailureNeverPublishesAnOnlineSession(t *testing.T) {
	fixture := newRPCFixture(t)
	fixture.client.input = rejectInitializedInput{fixture.client.input}
	stopped := make(chan struct{})
	close(stopped)
	worker, _ := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
		return &Executor{RPC: fixture.client, Stopped: stopped}, nil
	}})
	done := make(chan error, 1)
	go func() {
		_, err := worker.Connect(t.Context())
		done <- err
	}()
	request := rpcMethod(t, fixture, "initialize")
	replyFixture(t, fixture, request, `{}`)

	if err := <-done; !errors.Is(err, ErrDisconnected) || worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("failed initialization notification became an online session", err)
	}
	if err := worker.CloseContext(t.Context()); err != nil {
		t.Fatal("failed initialization did not join its executor", err)
	}
}

type revokingConversationSource struct {
	*workerSourceFixture
	mu     sync.Mutex
	revoke func()
}

func (source *revokingConversationSource) ConversationID() string {
	source.mu.Lock()
	revoke := source.revoke
	source.revoke = nil
	source.mu.Unlock()
	if revoke != nil {
		revoke()
	}
	return source.Snapshot().ConversationID
}

func TestWorkerFinalHandshakeCommitRechecksOwnershipAfterReadingItsConversation(t *testing.T) {
	fixture := newRPCFixture(t)
	stopped := make(chan struct{})
	close(stopped)
	worker, original := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
		return &Executor{RPC: fixture.client, Stopped: stopped}, nil
	}})
	source := &revokingConversationSource{workerSourceFixture: original}
	worker.source = source
	done := make(chan error, 1)
	go func() {
		_, err := worker.Connect(t.Context())
		done <- err
	}()
	for _, method := range []string{"initialize", "account/read", "model/list"} {
		request := rpcMethod(t, fixture, method)
		if method == "model/list" {
			source.mu.Lock()
			source.revoke = worker.Disconnect
			source.mu.Unlock()
		}
		replyFixture(t, fixture, request, `{}`)
		if method == "initialize" {
			rpcMethod(t, fixture, "initialized")
		}
	}
	if err := <-done; !errors.Is(err, ErrConnectionChanged) || worker.Snapshot().Status != contracts.ConnectionStatusOffline || worker.Snapshot().Account != nil {
		t.Fatal("revoked handshake owner published an online account", err)
	}
	if err := worker.CloseContext(t.Context()); err != nil {
		t.Fatal("revoked handshake did not join its process", err)
	}
}

func TestWorkerCloseRequiresItsOwnedMonitorsToJoin(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	gate, joined := make(chan struct{}), make(chan struct{})
	worker.monitors.Add(1)
	go func() {
		defer close(joined)
		defer worker.monitors.Done()
		<-gate
	}()
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := worker.CloseContext(cancelled); !errors.Is(err, ErrStopUnconfirmed) {
		t.Fatal("worker reported a complete shutdown before its monitor joined", err)
	}
	close(gate)
	<-joined
	if err := worker.CloseContext(t.Context()); err != nil {
		t.Fatal("joined worker could not confirm its shutdown", err)
	}
}

func TestVMHostDefaultDetectionDoesNotAdoptAnUnavailableDetector(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := VerifyVMHost(t.Context(), "linux", 1000, nil); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("missing virtualization detector was treated as a confirmed VM", err)
	}
}

func TestRPCFileChangesRetainStringKindsAndTheirOpaqueExtensions(t *testing.T) {
	result, err := ReadRPCResult(json.RawMessage(`{"turn":{"id":"isolated-turn","items":[{"id":"isolated-item","type":"fileChange","changes":[{"path":"relative.txt","kind":"update","diff":"synthetic diff","future":true},{"path":"new.txt"}]}]}}`))
	if err != nil || result["turn"] == nil {
		t.Fatal("valid file changes lost their supported kind representation", err)
	}
}
