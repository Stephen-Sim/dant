package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type directConversationSource struct{ *workerSourceFixture }

func (source directConversationSource) ConversationID() string {
	return source.Snapshot().ConversationID
}

func TestWorkerLifetimeCancellationRetiresTheCurrentConnectionAttempt(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	started := make(chan struct{})
	worker.options.VerifyRuntime = func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	done := make(chan error, 1)
	go func() { _, err := worker.Connect(t.Context()); done <- err }()
	<-started
	worker.Disconnect()
	if err := <-done; !errors.Is(err, context.Canceled) || worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("disconnected connection attempt later became online", err)
	}
	if err := worker.CloseContext(t.Context()); err != nil {
		t.Fatal("cancelled connection lifetime was not joined", err)
	}
}

func TestWorkerGuardRejectsConversationChangedByPreparationWithoutSending(t *testing.T) {
	fixture := newRPCFixture(t)
	worker, source := workerFixture(t, WorkerOptions{})
	worker.rpc, worker.status = fixture.client, contracts.ConnectionStatusOnline
	worker.source = directConversationSource{source}
	worker.options.TransformRequest = func(_ string, params contracts.RawObject, _ []*contracts.ChatMessage) (contracts.RawObject, error) {
		source.setConversation("replacement")
		return params, nil
	}
	if _, err := worker.Request(t.Context(), "turn/start", nil); !errors.Is(err, ErrConnectionChanged) {
		t.Fatal("changed preparation owner reached process admission", err)
	}
	select {
	case <-fixture.requests:
		t.Fatal("request for the previous conversation was transmitted")
	default:
	}
	stopped := make(chan struct{})
	close(stopped)
	worker.executor = &Executor{RPC: fixture.client, Stopped: stopped}
	if confirmed, err := worker.TerminateConfirmed(t.Context()); err != nil || !confirmed || !fixture.client.Closed() {
		t.Fatal("confirmed executor termination left its RPC usable", err)
	}
}

func TestVoiceMessageRejectsOccupiedOrCancelledOutputBeforeInvokingItsHelper(t *testing.T) {
	for _, kind := range []string{"occupied output", "cancelled worker", "default helper"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newRPCFixture(t)
			worker, source := workerFixture(t, WorkerOptions{})
			worker.source = directConversationSource{source}
			worker.rpc, worker.status = fixture.client, contracts.ConnectionStatusOnline
			output := filepath.Join(worker.WorkspaceRoot(), worker.conversationID(), "output")
			if kind == "occupied output" {
				if err := os.MkdirAll(filepath.Dir(output), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(output, []byte("occupied file"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if kind == "cancelled worker" {
				worker.cancel()
			}
			// In the default-helper case the configured temporary Home has no
			// voice_message.py. No installed helper or real device is invoked.
			if _, err := worker.CreateVoiceMessage(t.Context(), VoiceMessageOptions{Text: "Synthetic fixture text", OutputDirectory: output}); err == nil {
				t.Fatal("unverified output or missing helper produced a voice artifact", kind)
			}
		})
	}
}

func TestAccountRefreshFailureKeepsItsPreviousSnapshotUntilTransportClosure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		stopped := make(chan struct{})
		close(stopped)
		worker, _ := workerFixture(t, WorkerOptions{Factory: func(context.Context, ProcessOptions) (*Executor, error) {
			return &Executor{RPC: fixture.client, Stopped: stopped}, nil
		}})
		connectAccountFixture(t, worker, fixture)
		fixture.send(t, `{"method":"account/updated","params":{}}`)
		request := rpcMethod(t, fixture, "account/read")
		raw, _ := json.Marshal(contracts.RawObject{"id": request["id"], "error": []byte(`{"code":-1,"message":"private fixture cause"}`)})
		fixture.send(t, string(raw))
		synctest.Wait()
		if worker.Snapshot().Status != contracts.ConnectionStatusOnline || string(worker.Snapshot().Account["account"]) != "null" {
			t.Fatal("rejected refresh corrupted the confirmed account snapshot")
		}
		fixture.send(t, `{"method":"account/updated","params":{}}`)
		rpcMethod(t, fixture, "account/read")
		fixture.client.Close()
		synctest.Wait()
		if worker.Snapshot().Status != contracts.ConnectionStatusOffline || worker.Snapshot().Account != nil {
			t.Fatal("closed refresh transport left an account published online")
		}
	})
}

func TestExecutorEnvironmentRejectsMalformedCapturedEntriesWithoutChangingTheCaller(t *testing.T) {
	input := []string{"missing equals", "=empty key", "BAD\x00KEY=value", "BAD=value\x00suffix", "VALID=earlier", "VALID=latest"}
	before := slices.Clone(input)
	environment := executorEnvironment(WorkerOptions{Home: t.TempDir(), Environment: input})
	if !slices.Equal(input, before) || !slices.Contains(environment, "VALID=latest") || slices.Contains(environment, "VALID=earlier") {
		t.Fatal("captured environment was mutated or duplicate keys lost their final value")
	}
	if len(environment) != 6 {
		t.Fatal("malformed environment entries reached the executor", len(environment))
	}
}
