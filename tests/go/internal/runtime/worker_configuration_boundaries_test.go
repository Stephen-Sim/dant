package runtime

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkerDefaultsResolveInsideAnIsolatedHomeAndNeverSpawnDuringConstruction(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir())
	source := &workerSourceFixture{}
	worker, err := NewLocalWorker(t.Context(), source, WorkerOptions{GuestOrigin: "http://127.0.0.1:4321"})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if worker.options.Home != home || worker.WorkspaceRoot() != filepath.Join(home, "dant", "workspaces") || !strings.HasPrefix(worker.RuntimeID(), "vm:") || worker.options.Platform == "" || worker.options.UID == nil || worker.options.Factory == nil || worker.options.Client == nil || worker.options.VerifyRuntime == nil {
		t.Fatal("runtime defaults did not resolve their configured boundaries")
	}
	if err := worker.options.VerifyRuntime(t.Context()); err == nil {
		t.Fatal("missing isolated VM proof was accepted")
	}
	for _, options := range []WorkerOptions{{}, {GuestOrigin: "https://foreign.invalid"}} {
		if _, err := NewLocalWorker(t.Context(), source, options); !errors.Is(err, ErrVMUnavailable) {
			t.Fatal("unvalidated guest origin was accepted", err)
		}
	}
	if _, err := NewLocalWorker(t.Context(), nil, WorkerOptions{GuestOrigin: "http://127.0.0.1:4321"}); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("missing conversation source accepted", err)
	}
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	if _, err := NewLocalWorker(t.Context(), source, WorkerOptions{GuestOrigin: "http://127.0.0.1:4321"}); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("missing home directory was silently replaced", err)
	}
}

func TestConcurrentWorkerConnectsShareOneAttemptAndRespectRequestCancellation(t *testing.T) {
	worker, _ := workerFixture(t, WorkerOptions{})
	entered := make(chan struct{})
	release := make(chan struct{})
	var verifications atomic.Int32
	worker.options.VerifyRuntime = func(ctx context.Context) error {
		if verifications.Add(1) == 1 {
			close(entered)
		}
		select {
		case <-release:
			return ErrVMUnavailable
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	result := make(chan error, 1)
	go func() { _, err := worker.Connect(t.Context()); result <- err }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("controlled connection attempt did not enter its proof boundary")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := worker.Connect(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatal("joined connection ignored request cancellation", err)
	}
	worker.mu.Lock()
	attempt := worker.connecting
	worker.mu.Unlock()
	close(release)
	if err := <-result; !errors.Is(err, ErrVMUnavailable) || verifications.Load() != 1 {
		t.Fatal("one rejected VM proof created overlapping connection attempts", err)
	}
	<-attempt.done
	if attempt.err == nil || worker.Snapshot().Error.Value == "" {
		t.Fatal("failed connection did not retain bounded failure metadata")
	}
}
