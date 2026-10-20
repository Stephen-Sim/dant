package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controllerSecretProtection struct{}

func (controllerSecretProtection) Protect(_ context.Context, value []byte) ([]byte, error) {
	return append([]byte("isolated-wrapper:"), value...), nil
}

func (controllerSecretProtection) Unprotect(_ context.Context, value []byte) ([]byte, error) {
	if !bytes.HasPrefix(value, []byte("isolated-wrapper:")) {
		return nil, errors.New("fixture_protection_invalid")
	}
	return append([]byte{}, value[len("isolated-wrapper:"):]...), nil
}

type controllerBackupTransport struct {
	archive        []byte
	metadata       backups.Metadata
	restoreEntered chan struct{}
	restoreRelease chan struct{}
	restores       atomic.Int32
}

func (transport *controllerBackupTransport) Target(context.Context, bool) (backups.Target, error) {
	version := transport.metadata.AppVersion
	return backups.Target{Identity: strings.Repeat("a", 64), Generation: 1, Online: true, Supported: true, Version: &version}, nil
}

func (transport *controllerBackupTransport) Export(context.Context) (backups.ExportSource, error) {
	metadata := transport.metadata
	metadata.ID = backups.NewID()
	return backups.ExportSource{Metadata: metadata, Stream: io.NopCloser(bytes.NewReader(transport.archive))}, nil
}

func (transport *controllerBackupTransport) Restore(ctx context.Context, reader io.Reader, id string, target backups.Target) error {
	transport.restores.Add(1)
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return err
	}
	if transport.restoreEntered != nil {
		close(transport.restoreEntered)
		select {
		case <-transport.restoreRelease:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (*controllerBackupTransport) Reconcile(context.Context, string, backups.Target) (bool, error) {
	return true, nil
}
func (*controllerBackupTransport) Rejected(context.Context, string, backups.Target) (bool, error) {
	return false, nil
}

func controllerBackupFixture(t *testing.T, app *App, save bool) (backups.Metadata, *controllerBackupTransport, <-chan struct{}) {
	t.Helper()
	content := []byte(`{"conversationId":"isolated"}`)
	stage := t.TempDir()
	if err := os.Mkdir(filepath.Join(stage, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "data", "state.json"), content, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(content)
	archive := backups.ValidatedArchive{
		Manifest:  backups.Manifest{SchemaVersion: 1, CreatedAt: 1000, AppVersion: "0.4.7-beta.15", SourceID: "isolated", Files: 1, Bytes: int64(len(content))},
		Directory: stage,
		Entries:   []backups.ArchiveEntry{{Domain: "data", Path: "state.json", Size: int64(len(content)), SHA256: hex.EncodeToString(hash[:])}},
	}
	var output bytes.Buffer
	if err := backups.WriteArchive(context.Background(), &output, archive); err != nil {
		t.Fatal(err)
	}
	metadata := backups.Metadata{ID: backups.NewID(), CreatedAt: 1000, AppVersion: "0.4.7-beta.15", Bytes: int64(len(content)), Files: 1, Source: strings.Repeat("a", 12)}
	vault, err := backups.NewVault(backups.VaultOptions{
		DataDir: app.options.DataDir, Protection: controllerSecretProtection{},
		Transform: func(ctx context.Context, request backups.TransformRequest) error {
			raw, err := json.Marshal(request)
			if err != nil {
				return err
			}
			return backups.RunTransform(ctx, bytes.NewReader(raw), io.Discard)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if save {
		if err := vault.Save(context.Background(), bytes.NewReader(output.Bytes()), metadata); err != nil {
			t.Fatal(err)
		}
	}
	transport := &controllerBackupTransport{metadata: metadata, archive: append([]byte{}, output.Bytes()...)}
	changed := make(chan struct{}, 16)
	manager, err := backups.NewManager(backups.ManagerOptions{
		Context: app.ctx, DataDir: app.options.DataDir, Vault: vault, Transport: transport,
		Allowed: func() bool { return true },
		Changed: func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	app.backups.Close()
	app.backups = manager
	return metadata, transport, changed
}

func waitControllerBackup(t *testing.T, app *App, changed <-chan struct{}) {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for app.backups.Busy() {
		select {
		case <-changed:
		case <-timer.C:
			t.Fatal("isolated backup did not settle")
		}
	}
}

func TestControllerBackupHTTPExportsOriginalBytesAndImportsWithoutNavigation(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	metadata, _, _ := controllerBackupFixture(t, app, true)
	response := controllerRecordedRequest(t, app, token, "POST", "/api/backups/"+metadata.ID+"/export", `{"passphrase":"isolated fixture passphrase"}`)
	if response.Code != 200 || response.Header().Get("Content-Type") != "application/octet-stream" || !strings.Contains(response.Header().Get("Content-Disposition"), metadata.ID+".dant") || response.Header().Get("Location") != "" || response.Body.Len() == 0 {
		t.Fatal("portable export did not return a downloadable authenticated attachment")
	}

	imported, _, _, importedToken := controllerAppFixture(t)
	controllerBackupFixture(t, imported, false)
	request := httptest.NewRequest("POST", "http://127.0.0.1:4317/api/backups/import", bytes.NewReader(response.Body.Bytes()))
	request.Header.Set("X-Dant-Token", importedToken)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Dant-Backup-Passphrase", base64.StdEncoding.EncodeToString([]byte("isolated fixture passphrase")))
	result := httptest.NewRecorder()
	imported.Handler().ServeHTTP(result, request)
	var body struct{ Backup backups.Metadata }
	if result.Code != 201 || json.Unmarshal(result.Body.Bytes(), &body) != nil || body.Backup != metadata {
		t.Fatal("portable import changed authenticated backup identity or metadata")
	}
	status, err := imported.backups.Status(context.Background())
	if err != nil || len(status.Backups) != 1 || status.Backups[0] != metadata {
		t.Fatal("successful portable import did not become available in the local catalog")
	}
}

func TestControllerBackupRestoreRequiresExactPreviewAndFencesConcurrentMutation(t *testing.T) {
	app, _, _, token := controllerAppFixture(t)
	metadata, transport, changed := controllerBackupFixture(t, app, true)
	transport.restoreEntered = make(chan struct{})
	transport.restoreRelease = make(chan struct{})
	defer func() {
		select {
		case <-transport.restoreRelease:
		default:
			close(transport.restoreRelease)
		}
	}()
	response := controllerRecordedRequest(t, app, token, "POST", "/api/backups/"+metadata.ID+"/preview", `{}`)
	var preview backups.Preview
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &preview) != nil || preview.Confirmation == "" || preview.Target.ID != strings.Repeat("a", 12) {
		t.Fatal("restore preview omitted its bound target and confirmation")
	}
	body, _ := json.Marshal(struct {
		Confirmation string `json:"confirmation"`
	}{preview.Confirmation})
	response = controllerRecordedRequest(t, app, token, "POST", "/api/backups/"+metadata.ID+"/restore", string(body))
	if response.Code != 202 {
		t.Fatal("confirmed restore was not admitted")
	}
	select {
	case <-transport.restoreEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("fixture restore was not dispatched")
	}
	assertControllerCode(t, controllerRecordedRequest(t, app, token, "PATCH", "/api/settings", `{"theme":"light"}`), 409, "backup_restore_unconfirmed")
	if response := controllerRecordedRequest(t, app, token, "GET", "/api/state", ""); response.Code != 200 {
		t.Fatal("restore hid read-only recovery state")
	}
	close(transport.restoreRelease)
	waitControllerBackup(t, app, changed)
	status, err := app.backups.Status(context.Background())
	if err != nil || status.Phase != contracts.BackupPhaseIdle || status.LastRestoredID == nil || *status.LastRestoredID != metadata.ID || transport.restores.Load() != 1 {
		t.Fatal("confirmed restore lost its receipt or replayed the restore action")
	}
	response = controllerRecordedRequest(t, app, token, "POST", "/api/backups/run", `{}`)
	if response.Code != http.StatusAccepted {
		t.Fatal("manual backup was not admitted after restore completed")
	}
	waitControllerBackup(t, app, changed)
	status, err = app.backups.Status(context.Background())
	if err != nil || len(status.Backups) != 2 || status.LastError != nil {
		t.Fatal("manual backup did not publish its authenticated local catalog entry")
	}
}
