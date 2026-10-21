package backups

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const restoreFixtureState = `{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"threadId":"old-thread","messages":[{"id":"user","role":"user","text":"keep中文","status":"running","time":17},{"id":"unknown","role":"user","status":"queued","submission":"submitting"}],"workTasks":[],"completions":[],"schedules":[{"id":"legacy-schedule","enabled":true,"status":"pending","userText":"unchanged"}]}`
const testRestoreID = "49954ce5-c8c5-4f6e-a7d8-531530d09479"

func restoreFixture(t *testing.T) RestoreOptions {
	t.Helper()
	parent := t.TempDir()
	data := filepath.Join(parent, "data")
	workspace := filepath.Join(parent, "workspace")
	for _, root := range []string{data, workspace} {
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
	}

	if err := os.WriteFile(filepath.Join(data, "original"), []byte("original data"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(workspace, "original"), []byte("original workspace"), 0600); err != nil {
		t.Fatal(err)
	}

	return RestoreOptions{DataDir: data, WorkspaceRoot: workspace, RestoreID: testRestoreID, AssertOffline: func(context.Context) error { return nil }}
}

func TestWorkerRestorePausesBeforeSwapAndNeverReplaysCommittedInput(t *testing.T) {
	options := restoreFixture(t)
	input := fixtureArchive([]byte(restoreFixtureState))
	receipt, err := RestoreWorkerBackup(context.Background(), options, bytes.NewReader(input))
	if err != nil || !receipt.Restored {
		t.Fatalf("restore failed: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(options.DataDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		ThreadID *string `json:"threadId"`
		Messages []struct {
			Status     contracts.MessageStatus    `json:"status"`
			Submission contracts.SubmissionStatus `json:"submission"`
			Time       int64                      `json:"time"`
		} `json:"messages"`
		Schedules []struct {
			Enabled bool                     `json:"enabled"`
			Status  contracts.ScheduleStatus `json:"status"`
		} `json:"schedules"`
	}

	if json.Unmarshal(raw, &state) != nil || state.ThreadID != nil || state.Messages[0].Status != "paused" || state.Messages[0].Time != 17 || state.Messages[1].Submission != contracts.SubmissionStatusUnknown || state.Schedules[0].Enabled || state.Schedules[0].Status != contracts.ScheduleStatusPaused {
		t.Fatal("restored state did not preserve identity while pausing execution")
	}

	if _, err := os.Lstat(filepath.Join(options.DataDir, "original")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old data remained live")
	}
	second, err := RestoreWorkerBackup(context.Background(), options, errorReader{})
	if err != nil || !second.Restored {
		t.Fatal("committed restore replayed input")
	}
	loaded, err := LoadedWorkerRestoreInfo(options.DataDir, options.WorkspaceRoot)
	if err != nil || !loaded.Restored || loaded.RestoreID == nil || *loaded.RestoreID != testRestoreID {
		t.Fatal("loaded receipt lost exact restore identity")
	}
	locations, _ := restoreLocations(options)
	if _, err := os.Lstat(locations.kernel); err != nil {
		t.Fatal("persistent kernel lock inode removed")
	}

	if _, err := os.Lstat(locations.journal); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("committed journal not cleaned")
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("input must not be read") }
func TestWorkerRestoreRollsBackEveryInterruptedRootSwapAndRecordsProof(t *testing.T) {
	for failure := 1; failure <= 5; failure++ {
		t.Run(string(rune('0'+failure)), func(t *testing.T) {
			options := restoreFixture(t)
			calls := 0
			options.Rename = func(ctx context.Context, from, to string) error {
				calls++
				if calls == failure {
					return io.ErrUnexpectedEOF
				}
				return files.RenameManaged(ctx, from, to)
			}
			if _, err := RestoreWorkerBackup(context.Background(), options, bytes.NewReader(fixtureArchive([]byte(restoreFixtureState)))); err == nil {
				t.Fatal("injected root move unexpectedly succeeded")
			}
			for _, root := range []string{options.DataDir, options.WorkspaceRoot} {
				if raw, err := os.ReadFile(filepath.Join(root, "original")); err != nil || !strings.HasPrefix(string(raw), "original") {
					t.Fatal("rollback did not restore original root")
				}
			}
			proof, err := InspectWorkerRestoreRejection(options)
			if err != nil || !proof.Rejected {
				t.Fatalf("rollback rejection proof absent: %v", err)
			}
			receipt, err := InspectWorkerRestore(options)
			if err != nil || receipt.Restored {
				t.Fatal("failed transaction was reported committed")
			}
		})
	}
}

func TestWorkerRestoreRejectsLiveServiceAndUnsafeRoots(t *testing.T) {
	options := restoreFixture(t)
	options.AssertOffline = func(context.Context) error { return ErrBusy }
	if _, err := RestoreWorkerBackup(context.Background(), options, bytes.NewReader(nil)); !errors.Is(err, ErrBusy) {
		t.Fatal("live service restore admitted")
	}
	options.AssertOffline = func(context.Context) error { return nil }
	options.WorkspaceRoot = filepath.Join(options.DataDir, "nested")
	if _, err := RestoreWorkerBackup(context.Background(), options, bytes.NewReader(nil)); !errors.Is(err, ErrInvalid) {
		t.Fatal("nested roots admitted")
	}
}

func TestWorkerCapturePreservesOpaqueWorkspaceAndSnapshotsOnlyOwnedSQLite(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	workspace := filepath.Join(root, "workspace")
	for _, directory := range []string{data, workspace, filepath.Join(data, "logs"), filepath.Join(workspace, "node_modules")} {
		if os.Mkdir(directory, 0700) != nil {
			t.Fatal("fixture directory")
		}
	}
	os.WriteFile(filepath.Join(data, "state.json"), []byte(restoreFixtureState), 0600)
	os.WriteFile(filepath.Join(data, "logs", "excluded"), []byte("excluded"), 0600)
	os.WriteFile(filepath.Join(workspace, "node_modules", "excluded"), nil, 0600)
	opaque := []byte("SQLite format 3\x00not an actual database\xff")
	os.WriteFile(filepath.Join(workspace, "browser.sqlite"), opaque, 0600)
	os.WriteFile(filepath.Join(workspace, "browser.sqlite-wal"), []byte{0, 1, 2, 255}, 0600)
	db, err := sql.Open("sqlite", filepath.Join(data, "owned.sqlite"))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.Exec("CREATE TABLE retained(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO retained VALUES(1,'isolated')"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	validations := 0
	capture, err := CreateWorkerBackup(context.Background(), WorkerBackupOptions{DataDir: data, WorkspaceRoot: workspace, TemporaryRoot: root, SourceID: "isolated", AppVersion: "0.4.7-beta.12", ValidateCurrent: func(context.Context) error { validations++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer capture.Close()
	if validations != 2 || capture.Archive.Manifest.Files != 4 {
		t.Fatal("capture guards or exclusions changed")
	}
	var encoded bytes.Buffer
	if err := capture.WriteTo(context.Background(), &encoded); err != nil {
		t.Fatal(err)
	}
	archive, err := ValidateArchive(context.Background(), bytes.NewReader(encoded.Bytes()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(filepath.Join(archive.Directory, "workspace", "browser.sqlite"))
	if err != nil || !bytes.Equal(copied, opaque) {
		t.Fatal("workspace database bytes changed")
	}
	db, err = sql.Open("sqlite", filepath.Join(archive.Directory, "data", "owned.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var retained string
	if db.QueryRow("SELECT value FROM retained WHERE id=1").Scan(&retained) != nil || retained != "isolated" {
		t.Fatal("owned SQLite snapshot unreadable")
	}
}

func TestWorkerCaptureRejectsChangedSourcesBeforeExposingStream(t *testing.T) {
	options := restoreFixture(t)
	os.WriteFile(filepath.Join(options.DataDir, "state.json"), []byte(restoreFixtureState), 0600)
	calls := 0
	_, err := CreateWorkerBackup(context.Background(), WorkerBackupOptions{DataDir: options.DataDir, WorkspaceRoot: options.WorkspaceRoot, TemporaryRoot: filepath.Dir(options.DataDir), SourceID: "isolated", AppVersion: "0.4.7", ValidateCurrent: func(context.Context) error {
		calls++
		if calls == 2 {
			os.WriteFile(filepath.Join(options.DataDir, "state.json"), []byte("changed"), 0600)
		}
		return nil
	}})
	if !errors.Is(err, ErrSourceChanged) {
		t.Fatal("changed capture was accepted")
	}
}

type fakeBackupService struct {
	running bool
	starts  int
}

func (service *fakeBackupService) Running(context.Context) (bool, error) { return service.running, nil }
func (service *fakeBackupService) Start(context.Context) error {
	service.running = true
	service.starts++
	return nil
}

func TestBackupCLIFinishRequiresExactReceiptAndNeverStartsOnFailure(t *testing.T) {
	options := restoreFixture(t)
	service := &fakeBackupService{}
	args := []string{"finish", "--data-dir", options.DataDir, "--workspace-root", options.WorkspaceRoot, "--restore-id", options.RestoreID}
	if RunCLI(context.Background(), args, nil, &bytes.Buffer{}, CLIOptions{Service: service}) == nil || service.starts != 0 {
		t.Fatal("finish started an unconfirmed restore")
	}

	if _, err := RestoreWorkerBackup(context.Background(), options, bytes.NewReader(fixtureArchive([]byte(restoreFixtureState)))); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := RunCLI(context.Background(), args, nil, &output, CLIOptions{Service: service}); err != nil || service.starts != 1 || !strings.Contains(output.String(), `"restored":true`) {
		t.Fatal("confirmed finish did not start exactly once")
	}

	if err := RunCLI(context.Background(), args, nil, &bytes.Buffer{}, CLIOptions{Service: service}); err != nil || service.starts != 1 {
		t.Fatal("finish repeated an already running service start")
	}
}
