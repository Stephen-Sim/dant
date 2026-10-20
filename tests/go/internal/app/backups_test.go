package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
)

func TestWorkerBackupExportsValidatedSQLiteAndOpaqueWorkspaceBytes(t *testing.T) {
	app := fixtureWorker(t)
	workspace := filepath.Join(app.options.Startup.WorkspaceRoot, app.store.ConversationID(), ".agents", "skills", "fixture")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	opaque := []byte{0, 255, 1, 128, 0, 42}
	if err := os.WriteFile(filepath.Join(workspace, "opaque.bin"), opaque, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.saveNote(t.Context(), "working-memory.md", "An explicit fixture preference."); err != nil {
		t.Fatal(err)
	}

	response := callWorker(app, http.MethodGet, "/api/backups/export", "")
	if response.Code != http.StatusOK {
		t.Fatalf("backup status %d: %s", response.Code, response.Body)
	}
	metadata, err := base64.StdEncoding.DecodeString(response.Header().Get("X-Dant-Backup-Metadata"))
	if err != nil {
		t.Fatal(err)
	}
	var info backups.Metadata
	if json.Unmarshal(metadata, &info) != nil || info.Files == 0 || info.AppVersion != app.options.Version {
		t.Fatal("backup did not expose validated metadata")
	}
	archive, err := backups.ValidateArchive(t.Context(), bytes.NewReader(response.Body.Bytes()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := backups.ValidateWorkerBackup(t.Context(), archive); err != nil {
		t.Fatal("export cannot be validated for restore", err)
	}
	var exported bool
	for _, entry := range archive.Entries {
		if entry.Path != app.store.ConversationID()+"/.agents/skills/fixture/opaque.bin" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(archive.Directory, entry.Domain, filepath.FromSlash(entry.Path)))
		if err != nil || !bytes.Equal(data, opaque) {
			t.Fatal("workspace bytes changed in backup", err)
		}
		exported = true
	}
	if !exported {
		t.Fatal("workspace binary file missing from backup")
	}
}

func TestWorkerMaintenanceRequiresExactLeaseAndBlocksLiveMutations(t *testing.T) {
	app := fixtureWorker(t)
	response := callWorker(app, http.MethodPost, "/api/updates/worker-maintenance", `{}`)
	var lease workerMaintenance
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &lease) != nil || lease.ID == "" {
		t.Fatalf("maintenance status %d: %s", response.Code, response.Body)
	}
	response = callWorker(app, http.MethodDelete, "/api/updates/worker-maintenance/wrong-id", "")
	if response.Code != http.StatusConflict || !app.engine.MaintenanceActive() {
		t.Fatal("a mismatched lease released maintenance")
	}
	response = callWorker(app, http.MethodPatch, "/api/settings", `{"language":"ja"}`)
	if response.Code < 400 || app.store.Snapshot().Settings.Language == "ja" {
		t.Fatal("settings changed across a maintenance reservation")
	}
	response = callWorker(app, http.MethodDelete, "/api/updates/worker-maintenance/"+lease.ID, "")
	if response.Code != http.StatusOK || app.engine.MaintenanceActive() {
		t.Fatal("the exact lease could not release maintenance")
	}
	response = callWorker(app, http.MethodPatch, "/api/settings", `{"language":"ja"}`)
	if response.Code != http.StatusOK {
		t.Fatal("settings did not resume after release")
	}
}
