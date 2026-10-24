package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"testing/synctest"
)

func connectAccountFixture(t *testing.T, worker *LocalWorker, fixture *rpcFixture) {
	t.Helper()
	done := make(chan error, 1)
	go func() { _, err := worker.Connect(context.Background()); done <- err }()
	replyFixture(t, fixture, rpcMethod(t, fixture, "initialize"), `{}`)
	rpcMethod(t, fixture, "initialized")
	replyFixture(t, fixture, rpcMethod(t, fixture, "account/read"), `{"account":null}`)
	replyFixture(t, fixture, rpcMethod(t, fixture, "model/list"), `{"data":[]}`)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestAccountLoginAndDisconnectPublishStateWithoutOpeningATaskThread(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		stopped := make(chan struct{})
		close(stopped)
		changes := make(chan struct{}, 16)
		worker, _ := workerFixture(t, WorkerOptions{Changed: func() {
			select {
			case changes <- struct{}{}:
			default:
			}
		}, Factory: func(context.Context, ProcessOptions) (*Executor, error) {
			return &Executor{RPC: fixture.client, Stopped: stopped}, nil
		}})
		connectAccountFixture(t, worker, fixture)
		fixture.send(t, `{"method":"account/login/completed","params":{"success":true}}`)
		refresh := rpcMethod(t, fixture, "account/read")
		for index := 0; index < RPCEventQueue*2; index++ {
			fixture.send(t, `{"method":"item/agentMessage/delta","params":{"itemId":"unrelated","delta":"observer"}}`)
		}
		replyFixture(t, fixture, refresh, `{"account":{"type":"chatgpt","planType":"fixture-plan"}}`)
		synctest.Wait()
		var account struct {
			Account struct {
				PlanType string `json:"planType"`
			} `json:"account"`
		}
		encoded, _ := json.Marshal(worker.Snapshot().Account)
		if json.Unmarshal(encoded, &account) != nil || account.Account.PlanType != "fixture-plan" || fixture.client.Closed() {
			t.Fatal("login did not refresh independent account state or task events overflowed its monitor")
		}
		if len(changes) < 3 {
			t.Fatal("account completion did not notify the API state projection")
		}
		worker.mu.Lock()
		priorEpoch := worker.accountEpoch
		worker.mu.Unlock()
		fixture.send(t, `{"method":"account/updated","params":{}}`)
		unchanged := rpcMethod(t, fixture, "account/read")
		worker.mu.Lock()
		invalidatedBeforeRead := worker.accountEpoch == priorEpoch+1
		worker.mu.Unlock()
		if !invalidatedBeforeRead {
			t.Fatal("an account notification retained authority while metadata was pending")
		}
		replyFixture(t, fixture, unchanged, `{"account":{"type":"chatgpt","planType":"fixture-plan"}}`)
		synctest.Wait()
		worker.mu.Lock()
		retainedInvalidation := worker.accountEpoch == priorEpoch+1
		worker.mu.Unlock()
		if !retainedInvalidation {
			t.Fatal("identical public metadata was mistaken for unchanged workspace ownership")
		}
		select {
		case request := <-fixture.requests:
			t.Fatalf("account observer opened unrelated work: %s", request["method"])
		default:
		}
		fixture.client.Close()
		synctest.Wait()
		if worker.Snapshot().Status != "offline" || worker.Snapshot().Account != nil {
			t.Fatal("idle executor disconnection did not clear published state")
		}
	})
}

func TestCloseContextRequiresActualExecutorStopProof(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		stopped := make(chan struct{})
		worker, _ := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
			return &Executor{RPC: fixture.client, Stopped: stopped, Stop: func() error { return nil }}, nil
		}})
		connectAccountFixture(t, worker, fixture)
		cancelled, cancel := context.WithCancel(context.Background())
		cancel()
		if err := worker.CloseContext(cancelled); !errors.Is(err, ErrStopUnconfirmed) {
			t.Fatal("API/RPC closure was misreported as a stopped child", err)
		}
		close(stopped)
		if err := worker.CloseContext(context.Background()); err != nil {
			t.Fatal("actual stopped child was not recognized", err)
		}
	})
}
