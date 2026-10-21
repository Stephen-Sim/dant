package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestWorkerBackupCannotCaptureAnUnconfirmedConnectingExecutor(t *testing.T) {
	options := fixtureWorkerOptions(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	options.WorkerOptions.VerifyRuntime = func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return workerRuntime.ErrDisconnected
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	defer releaseOnce.Do(func() { close(release) })
	finished := make(chan error, 1)
	go func() {
		_, err := app.worker.Connect(t.Context())
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("isolated connection did not enter verification")
	}
	if app.worker.Snapshot().Status != contracts.ConnectionStatusConnecting {
		t.Fatal("verification did not retain an unconfirmed connection state")
	}
	response := callWorker(app, http.MethodGet, "/api/backups/export", "")
	requireWorkerStatus(t, response, http.StatusConflict)
	if !strings.Contains(response.Body.String(), `"code":"backup_busy"`) || response.Header().Get("X-Dant-Backup-Metadata") != "" || app.engine.MaintenanceActive() {
		t.Fatal("unconfirmed connection published backup success or retained maintenance")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-finished:
		if !errors.Is(err, workerRuntime.ErrDisconnected) {
			t.Fatal("isolated verification lost its failure classification", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("isolated verification did not release its connection owner")
	}
}
