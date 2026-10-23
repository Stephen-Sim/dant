package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRPCClosureKeepsItsFirstClassifiedCauseWithoutPendingRequests(t *testing.T) {
	fixture := newRPCFixture(t)
	fixture.client.fail(ErrInvalidProtocol)
	fixture.client.failWith(DisconnectProcessExit, ErrDisconnected)
	fixture.client.Close()
	<-fixture.client.Done()
	if fixture.client.closureReason() != DisconnectProtocol {
		t.Fatal("later cleanup replaced the first transport failure")
	}
}

func TestRPCDeadlineRetainsRequestTimeoutInsteadOfInventingAReadFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		result := make(chan error, 1)
		go func() {
			_, err := fixture.client.Request(context.Background(), "turn/start", nil)
			result <- err
		}()
		<-fixture.requests
		time.Sleep(RequestTimeout)
		err := <-result
		var operation *OperationError
		if !errors.Is(err, ErrRequestTimeout) || !errors.As(err, &operation) || !operation.UnconfirmedOutcome() {
			t.Fatal("request deadline changed a sent action into a confirmed or retryable outcome")
		}
		_ = fixture.output.Close()
		fixture.client.Close()
		<-fixture.client.Done()
		if fixture.client.closureReason() != DisconnectRequestTimeout {
			t.Fatal("later EOF or cleanup replaced the actual RPC deadline failure")
		}
	})
}

func TestGenericRPCDisconnectionDoesNotClaimAReadFailure(t *testing.T) {
	fixture := newRPCFixture(t)
	fixture.client.fail(ErrDisconnected)
	fixture.client.failWith(DisconnectReadError, ErrDisconnected)
	<-fixture.client.Done()
	if fixture.client.closureReason() != DisconnectUnknown {
		t.Fatal("unclassified retirement invented a read failure")
	}
}

func TestRPCReadClosureClassifiesEOFProtocolAndPrivateReadErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		reason DisconnectReason
		end    func(*rpcFixture)
	}{
		{"eof", DisconnectEOF, func(f *rpcFixture) { _ = f.output.Close() }},
		{"read-error", DisconnectReadError, func(f *rpcFixture) { _ = f.output.CloseWithError(errors.New("private provider output")) }},
		{"protocol", DisconnectProtocol, func(f *rpcFixture) { _, _ = io.WriteString(f.output, "private provider output\n") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRPCFixture(t)
			test.end(fixture)
			<-fixture.client.Done()
			fixture.client.Close()
			if fixture.client.closureReason() != test.reason {
				t.Fatal("transport closure lost its fixed classification")
			}
			encoded, _ := json.Marshal(DisconnectInfo{Reason: fixture.client.closureReason()})
			if strings.Contains(string(encoded), "private") {
				t.Fatal("closure metadata retained provider output")
			}
		})
	}
}

type failedDiagnosticWriter struct{}

func (failedDiagnosticWriter) Write([]byte) (int, error) {
	return 0, errors.New("private write failure")
}
func (failedDiagnosticWriter) Close() error { return nil }

func TestRPCWriteAndContextClosureRemainDistinctWithoutLeakingRawErrors(t *testing.T) {
	output, producer := io.Pipe()
	client, err := NewRPC(t.Context(), failedDiagnosticWriter{}, output, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); _ = producer.Close(); <-client.Done() })
	_, err = client.Request(t.Context(), "turn/start", nil)
	var operation *OperationError
	if !errors.As(err, &operation) || !operation.UnconfirmedOutcome() || strings.Contains(err.Error(), "private") {
		t.Fatal("write classification changed unknown outcome or exposed raw failure")
	}
	<-client.Done()
	if client.closureReason() != DisconnectWriteFailure {
		t.Fatal("physical write failure was reduced to a generic close")
	}

	ctx, cancel := context.WithCancel(t.Context())
	input, inputWriter := io.Pipe()
	reader, writer := io.Pipe()
	cancelled, err := NewRPC(ctx, inputWriter, reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	<-cancelled.Done()
	_ = input.Close()
	_ = writer.Close()
	cancelled.Close()
	if cancelled.closureReason() != DisconnectContext {
		t.Fatal("lifetime cancellation was overwritten by cleanup")
	}
}

func TestOfflineDiagnosticWaitsForExitMetadataAfterEOFWithoutDelayingOfflineState(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		stopped := make(chan struct{})
		exit := ProcessExit{}
		reports := make(chan DisconnectInfo, 2)
		worker, _ := workerFixture(t, WorkerOptions{Disconnected: func(info DisconnectInfo) { reports <- info }, Factory: func(context.Context, ProcessOptions) (*Executor, error) {
			return &Executor{RPC: fixture.client, Stopped: stopped, ExitInfo: func() ProcessExit { return exit }}, nil
		}})
		connectAccountFixture(t, worker, fixture)
		_ = fixture.output.Close()
		synctest.Wait()
		if worker.Snapshot().Status != contracts.ConnectionStatusOffline || len(reports) != 0 {
			t.Fatal("EOF delayed offline state or published before process exit metadata")
		}
		exit = ProcessExit{Observed: true, Code: 17, StopRequested: true}
		close(stopped)
		synctest.Wait()
		info := <-reports
		if info.Reason != DisconnectEOF || !info.ProcessStopped || info.Exit != exit || info.Generation != worker.Snapshot().Generation {
			t.Fatal("EOF-first diagnostic lost its later process result or exact owner")
		}
		fixture.client.Close()
		synctest.Wait()
		if len(reports) != 0 {
			t.Fatal("one disconnected generation produced duplicate diagnostics")
		}
	})
}

func TestOfflineDiagnosticIsBoundedAndCannotPublishOverAReplacementGeneration(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "bounded-stop", true: "replacement"}[replace], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newRPCFixture(t)
				stopped := make(chan struct{})
				reports := make(chan DisconnectInfo, 2)
				worker, _ := workerFixture(t, WorkerOptions{Disconnected: func(info DisconnectInfo) { reports <- info }, Factory: func(context.Context, ProcessOptions) (*Executor, error) {
					return &Executor{RPC: fixture.client, Stopped: stopped}, nil
				}})
				connectAccountFixture(t, worker, fixture)
				fixture.client.failWith(DisconnectEventOverflow, ErrBackpressure)
				synctest.Wait()
				if replace {
					worker.mu.Lock()
					worker.generation++
					worker.status = contracts.ConnectionStatusOnline
					worker.mu.Unlock()
					close(stopped)
				} else {
					time.Sleep(ExecutorStopTimeout)
				}
				synctest.Wait()
				if replace {
					if len(reports) != 0 || worker.Snapshot().Status != contracts.ConnectionStatusOnline {
						t.Fatal("retired generation overwrote or diagnosed the replacement connection")
					}
				} else {
					info := <-reports
					if info.Reason != DisconnectEventOverflow || info.ProcessStopped || info.Exit.Observed {
						t.Fatal("bounded join invented a confirmed process exit")
					}
				}
			})
		})
	}
}

func TestExplicitDisconnectDoesNotPublishAnUnexpectedFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		stopped := make(chan struct{})
		close(stopped)
		calls := 0
		worker, _ := workerFixture(t, WorkerOptions{Disconnected: func(DisconnectInfo) { calls++ }, Factory: func(context.Context, ProcessOptions) (*Executor, error) {
			return &Executor{RPC: fixture.client, Stopped: stopped}, nil
		}})
		connectAccountFixture(t, worker, fixture)
		worker.Disconnect()
		synctest.Wait()
		if calls != 0 || fixture.client.closureReason() != DisconnectExplicit {
			t.Fatal("normal explicit disconnect was logged as an unexpected failure")
		}
	})
}
