package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
)

func TestWorkerBackupRejectsBusyAndInvalidAuthorityWithoutPartialSuccess(t *testing.T) {
	active, _, _ := acknowledgedToolFixture(t)
	response := callWorker(active, http.MethodGet, "/api/backups/export", "")
	requireWorkerStatus(t, response, 409)
	if !strings.Contains(response.Body.String(), "backup_busy") || response.Header().Get("X-Dant-Backup-Metadata") != "" {
		t.Fatal("busy export published a success header")
	}
	requireWorkerStatus(t, callWorker(active, http.MethodPost, "/api/updates/worker-maintenance", `{}`), 409)
	app := fixtureWorker(t)
	staging := t.TempDir()
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, staging)
	}
	file := filepath.Join(app.options.Startup.DataDir, "memory", "dant", "memory.sqlite")
	if err := os.WriteFile(file, []byte("preserved malformed authority"), 0o600); err != nil {
		t.Fatal(err)
	}
	response = callWorker(app, http.MethodGet, "/api/backups/export", "")
	requireWorkerStatus(t, response, 500)
	if !strings.Contains(response.Body.String(), "backup_failed") || strings.Contains(response.Body.String(), "preserved malformed authority") {
		t.Fatal("backup failure leaked source contents or claimed success")
	}
	if response.Header().Get("X-Dant-Backup-Metadata") != "" || response.Header().Get("Content-Type") == "application/x-dant-backup" {
		t.Fatal("validation failure published backup success headers")
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "preserved malformed authority" {
		t.Fatal("read-only snapshot validation rewrote source evidence")
	}
	if entries, err := os.ReadDir(staging); err != nil || len(entries) != 0 {
		t.Fatal("failed private snapshot was not released")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4317/api/backups/export", nil).WithContext(cancelled)
	response = httptest.NewRecorder()
	app.exportBackup(response, request)
	if response.Code < 400 || response.Header().Get("X-Dant-Backup-Metadata") != "" {
		t.Fatal("cancelled snapshot was published")
	}
	if entries, err := os.ReadDir(staging); err != nil || len(entries) != 0 {
		t.Fatal("cancelled snapshot retained staging")
	}
}

func TestWorkerBackupStreamFailureAbortsTransportWithoutAppendingSuccessfulJSON(t *testing.T) {
	app := fixtureWorker(t)
	writer := &failedEventWriter{noFlushWriter: noFlushWriter{header: make(http.Header)}}
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("stream failure did not abort HTTP: %v", recovered)
		}
		if writer.writes != 1 || writer.Header().Get("Content-Type") != "application/x-dant-backup" {
			t.Fatal("backup stream was replayed or lost its transport identity")
		}
	}()
	app.exportBackup(writer, httptest.NewRequest(http.MethodGet, "/api/backups/export", nil))
}

func TestWorkerBackupCurrentGuardAndMaintenanceReleaseRemainExplicit(t *testing.T) {
	writer := &failedEventWriter{noFlushWriter: noFlushWriter{header: make(http.Header)}}
	guarded := guardedBackupWriter{writer: writer, current: func() bool { return false }}
	if count, err := guarded.Write([]byte("private fixture")); count != 0 || !errors.Is(err, backups.ErrSourceChanged) || writer.writes != 0 {
		t.Fatal("retired snapshot wrote to its transport")
	}
	app := fixtureWorker(t)
	lease, err := app.reserveMaintenance(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if repeated, err := app.reserveMaintenance(t.Context()); err != nil || repeated.ID != lease.ID {
		t.Fatal("existing maintenance reservation was duplicated")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/updates/worker-maintenance", ""), 200)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	request := httptest.NewRequest(http.MethodDelete, "http://127.0.0.1:4317/api/updates/worker-maintenance/"+lease.ID, nil).WithContext(ctx)
	request.Header.Set("X-Dant-Token", app.auth.Info().Token)
	app.Handler().ServeHTTP(httptest.NewRecorder(), request)
	<-lease.done
	if app.engine.MaintenanceActive() {
		t.Fatal("cancelled release retained admission indefinitely")
	}
	app.Close()
	if _, err := app.reserveMaintenance(context.Background()); err == nil {
		t.Fatal("closed Worker reserved maintenance")
	}
}
