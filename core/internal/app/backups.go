package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type workerMaintenance struct {
	ID     string `json:"id"`
	cancel context.CancelFunc
	done   chan struct{}
}

type guardedBackupWriter struct {
	writer  http.ResponseWriter
	current func() bool
}

func (writer guardedBackupWriter) Write(data []byte) (int, error) {
	if !writer.current() {
		return 0, backups.ErrSourceChanged
	}
	_ = http.NewResponseController(writer.writer).SetWriteDeadline(time.Now().Add(eventWriteTimeout))
	return writer.writer.Write(data)
}

func (app *WorkerApp) registerBackupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/backups/export", app.exportBackup)
	httpapi.Register(mux, "POST /api/updates/worker-maintenance", func(writer http.ResponseWriter, request *http.Request) error {
		lease, err := app.reserveMaintenance(request.Context())
		if err != nil {
			return httpapi.Failure(409, "worker_busy", "The work computer is busy or changed during maintenance.")
		}
		return httpapi.JSON(writer, lease)
	})
	httpapi.Register(mux, "GET /api/updates/worker-maintenance", func(writer http.ResponseWriter, _ *http.Request) error {
		app.maintenanceMu.Lock()
		defer app.maintenanceMu.Unlock()
		return httpapi.JSON(writer, app.maintenance)
	})
	httpapi.Register(mux, "DELETE /api/updates/worker-maintenance/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		app.maintenanceMu.Lock()
		lease := app.maintenance
		if lease == nil || lease.ID != request.PathValue("id") {
			app.maintenanceMu.Unlock()
			return httpapi.Failure(409, "maintenance_changed", "The maintenance reservation changed.")
		}
		lease.cancel()
		app.maintenanceMu.Unlock()
		select {
		case <-request.Context().Done():
			return request.Context().Err()
		case <-lease.done:
		}
		return httpapi.JSON(writer, struct {
			Released bool `json:"released"`
		}{true})
	})
}

func (app *WorkerApp) reserveMaintenance(ctx context.Context) (*workerMaintenance, error) {
	app.lifecycle.Lock()
	defer app.lifecycle.Unlock()
	if app.closed {
		return nil, errUnavailable
	}
	app.maintenanceMu.Lock()
	defer app.maintenanceMu.Unlock()
	if app.maintenance != nil {
		return app.maintenance, nil
	}
	owner, cancel := context.WithCancel(app.ctx)
	lease := &workerMaintenance{ID: backups.NewID(), cancel: cancel, done: make(chan struct{})}
	ready := make(chan error, 1)
	app.wg.Add(1)
	go func() {
		defer app.wg.Done()
		defer close(lease.done)
		accepted := false
		err := app.engine.MaintenanceTransaction(owner, func(ctx context.Context, current func() bool) error {
			if !current() {
				return work.ErrStaleOwner
			}
			accepted = true
			ready <- nil
			<-ctx.Done()
			return ctx.Err()
		})
		if !accepted {
			ready <- err
		}
		app.maintenanceMu.Lock()
		if app.maintenance == lease {
			app.maintenance = nil
		}
		app.maintenanceMu.Unlock()
	}()
	select {
	case <-ctx.Done():
		cancel()
		return nil, ctx.Err()
	case err := <-ready:
		if err != nil {
			cancel()
			return nil, err
		}
		app.maintenance = lease
		return lease, nil
	}
}

func (app *WorkerApp) exportBackup(writer http.ResponseWriter, request *http.Request) {
	wrote := false
	err := app.engine.MaintenanceTransaction(request.Context(), func(ctx context.Context, current func() bool) error {
		worker := app.worker.Snapshot()
		if worker.Status != contracts.ConnectionStatusOnline && worker.Status != contracts.ConnectionStatusOffline {
			return work.ErrBusy
		}
		if app.computer.Pending() {
			return work.ErrBusy
		}
		source := sha256.Sum256([]byte(app.worker.RuntimeID()))
		archive, err := backups.CreateWorkerBackup(ctx, backups.WorkerBackupOptions{
			DataDir: app.options.Startup.DataDir, WorkspaceRoot: app.options.Startup.WorkspaceRoot,
			SourceID: hex.EncodeToString(source[:]), AppVersion: app.options.Version,
			ValidateCurrent: func(ctx context.Context) error {
				if !current() {
					return backups.ErrSourceChanged
				}
				return ctx.Err()
			},
		})
		if err != nil {
			return err
		}
		defer archive.Close()
		manifest := archive.Archive.Manifest
		metadata := backups.Metadata{
			ID: backups.NewID(), CreatedAt: manifest.CreatedAt, AppVersion: manifest.AppVersion,
			Bytes: manifest.Bytes, Files: manifest.Files, Source: hex.EncodeToString(source[:])[:12],
		}
		if !current() {
			return backups.ErrSourceChanged
		}
		writer.Header().Set("Content-Type", "application/x-dant-backup")
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Dant-Backup-Metadata", base64.StdEncoding.EncodeToString(encode(metadata)))
		wrote = true
		return archive.WriteTo(ctx, guardedBackupWriter{writer: writer, current: current})
	})
	if err == nil {
		return
	}
	if wrote {
		panic(http.ErrAbortHandler)
	}
	status := http.StatusInternalServerError
	code := "backup_failed"
	if errors.Is(err, work.ErrBusy) || errors.Is(err, work.ErrStaleOwner) || errors.Is(err, backups.ErrSourceChanged) {
		status = http.StatusConflict
		code = "backup_busy"
	}
	httpapi.WriteError(writer, httpapi.Failure(status, code, "The work computer backup could not be created."))
}

var _ io.Writer = guardedBackupWriter{}
