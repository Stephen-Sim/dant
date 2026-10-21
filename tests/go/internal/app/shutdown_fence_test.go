package app

import (
	"context"
	"errors"
	"io/fs"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestWorkerShutdownKeepsUnconfirmedTerminationFencedAndReportsFailedDurability(t *testing.T) {
	for _, failFence := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			var fail atomic.Bool
			var actualStop <-chan struct{}
			var exitProof chan struct{}
			app, _ := connectedWorkerFixture(t, func(options *WorkerOptions) {
				factory := options.WorkerOptions.Factory
				options.WorkerOptions.Factory = func(ctx context.Context, process workerRuntime.ProcessOptions) (*workerRuntime.Executor, error) {
					executor, err := factory(ctx, process)
					if err != nil {
						return nil, err
					}
					// The fake process closes its real pipes, while independent exit
					// proof remains unavailable. No OS process is started or killed.
					actualStop = executor.Stopped
					exitProof = make(chan struct{})
					executor.Stopped = exitProof
					return executor, nil
				}
				options.StoreOptions.Write = func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
					if fail.Load() {
						return errors.New("synthetic fence persistence failure")
					}
					return files.WriteAtomic(ctx, path, data, mode)
				}
			})
			fail.Store(failFence)
			app.Close()
			defer func() {
				<-actualStop
				close(exitProof)
				_ = app.owner.Close()
			}()
			if _, err := ownership.Acquire(t.Context(), app.options.Startup.DataDir); !errors.Is(err, ownership.ErrBusy) {
				t.Fatal("unconfirmed process exit released its ownership lock", err)
			}
			if !failFence && !app.engine.UnconfirmedStop() {
				t.Fatal("unconfirmed process termination was presented as safe to reconnect")
			}
			records, err := app.diagnostics.Recent(t.Context(), 20)
			if err != nil {
				t.Fatal(err)
			}
			want := "EXECUTOR_STOP_UNCONFIRMED"
			if failFence {
				want = "EXECUTOR_STOP_FENCE_FAILED"
			}
			found := false
			for _, record := range records {
				if record.Code == want {
					found = true
				}
			}
			if !found {
				t.Fatal("shutdown hid uncertainty or a failed durable fence")
			}
		})
	}
}

func TestWorkerCancelledConstructionAndCancelledParentAlwaysJoinOwnedDiagnostics(t *testing.T) {
	options := fixtureWorkerOptions(t)
	ctx, cancel := context.WithCancel(t.Context())
	options.StoreOptions.Write = func(operation context.Context, path string, data []byte, mode fs.FileMode) error {
		cancel()
		return files.WriteAtomic(operation, path, data, mode)
	}
	app, err := NewWorker(ctx, options)
	if err == nil || app == nil || app.diagnostics == nil || !app.diagnostics.Status().Closed {
		t.Fatal("cancelled partial construction did not join its owned logger", err)
	}
	lock, err := ownership.Acquire(t.Context(), options.Startup.DataDir)
	if err != nil {
		t.Fatal("cancelled construction retained its data ownership", err)
	}
	_ = lock.Close()

	options = fixtureWorkerOptions(t)
	ctx, cancel = context.WithCancel(t.Context())
	app, err = NewWorker(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if !app.diagnostics.Log("worker.shutdown", diagnostics.Fields{Code: "FIXTURE_SHUTDOWN"}) {
		t.Fatal("execution cancellation discarded final owned diagnostics")
	}
	app.Close()
	if !app.diagnostics.Status().Closed {
		t.Fatal("explicit composition shutdown did not join diagnostics")
	}
	lock, err = ownership.Acquire(t.Context(), options.Startup.DataDir)
	if err != nil {
		t.Fatal("explicit shutdown retained parent-cancelled data ownership", err)
	}
	_ = lock.Close()
}
