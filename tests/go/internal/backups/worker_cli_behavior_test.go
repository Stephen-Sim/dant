package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type cliServiceFixture struct {
	checks int
	starts int
	check  func(int) (bool, error)
	start  error
}

func (service *cliServiceFixture) Running(context.Context) (bool, error) {
	service.checks++
	if service.check != nil {
		return service.check(service.checks)
	}
	return false, nil
}
func (service *cliServiceFixture) Start(context.Context) error {
	service.starts++
	return service.start
}

type backupFailWriter struct{ calls int }

func (writer *backupFailWriter) Write([]byte) (int, error) {
	writer.calls++
	return 0, io.ErrClosedPipe
}

func cliRoots(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	data, workspace := filepath.Join(root, "data"), filepath.Join(root, "workspace")
	for _, name := range []string{data, workspace} {
		if err := os.Mkdir(name, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(data, "state.json"), []byte(cliFixtureState), 0600); err != nil {
		t.Fatal(err)
	}
	return data, workspace
}

func TestBackupCLIRejectsAmbiguousArgumentsWithoutReadingOrWriting(t *testing.T) {
	data, workspace := cliRoots(t)
	valid := []string{"inspect", "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID}
	for _, args := range [][]string{
		nil, {"unknown"}, {"export", "--data-dir"},
		{"inspect", "--unknown", "x"},
		{"inspect", "--data-dir", "relative", "--workspace-root", workspace, "--restore-id", testRestoreID},
		{"inspect", "--data-dir", data, "--workspace-root", workspace, "--restore-id", "unsafe"},
		{"inspect", "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID, "--source-id", "isolated"},
		{"export", "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID, "--source-id", "isolated"},
		{"export", "--data-dir", data, "--workspace-root", workspace, "--source-id", ""},
		{"export", "--data-dir", data, "--workspace-root", workspace, "--source-id", "a\x00b"},
		append(append([]string{}, valid...), "--data-dir", data),
	} {
		var output bytes.Buffer
		service := &cliServiceFixture{}
		if err := RunCLI(t.Context(), args, errorReader{}, &output, CLIOptions{Service: service}); !errors.Is(err, ErrInvalid) || output.Len() != 0 || service.checks != 0 || service.starts != 0 {
			t.Fatalf("invalid CLI arguments crossed a side-effect boundary: %v", err)
		}
	}
	if err := RunCLI(t.Context(), valid, errorReader{}, io.Discard, CLIOptions{}, CLIOptions{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("multiple configurations accepted")
	}
}

func TestBackupCLIRestoreRecoverInspectAndOutcomeKeepExactReceipt(t *testing.T) {
	data, workspace := cliRoots(t)
	service := &cliServiceFixture{}
	run := func(command string, input io.Reader, writer io.Writer) error {
		return RunCLI(t.Context(), []string{command, "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID}, input, writer, CLIOptions{Service: service})
	}
	var output bytes.Buffer
	if err := run("restore", bytes.NewReader(fixtureArchive([]byte(cliFixtureState))), &output); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"restore", "inspect", "recover", "finish"} {
		output.Reset()
		if err := run(command, errorReader{}, &output); err != nil {
			t.Fatalf("%s: %v", command, err)
		}
		var receipt RestoreReceipt
		if json.Unmarshal(output.Bytes(), &receipt) != nil || !receipt.Restored || receipt.RestoreID != testRestoreID {
			t.Fatal("idempotent CLI path lost authoritative receipt")
		}
	}
	output.Reset()
	if err := run("outcome", errorReader{}, &output); err != nil {
		t.Fatal(err)
	}
	var rejected RestoreRejection
	if json.Unmarshal(output.Bytes(), &rejected) != nil || rejected.Rejected || rejected.RestoreID != testRestoreID {
		t.Fatal("completed restoration reported safe rejection")
	}
	if service.starts != 1 {
		t.Fatal("only explicit confirmed finish may start service")
	}
	service.start = context.Canceled
	output.Reset()
	if err := run("finish", errorReader{}, &output); !errors.Is(err, context.Canceled) || output.Len() != 0 {
		t.Fatal("failed service start published success")
	}
	service.check = func(int) (bool, error) { return false, context.DeadlineExceeded }
	if err := run("finish", errorReader{}, &output); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("failed service observation ignored")
	}
}

func TestBackupCLIExportChecksOfflineThroughValidationAndPreservesArchive(t *testing.T) {
	for _, mode := range []string{"valid", "initial-running", "late-running", "cancelled", "service-error", "writer-error"} {
		t.Run(mode, func(t *testing.T) {
			data, workspace := cliRoots(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			service := &cliServiceFixture{check: func(call int) (bool, error) {
				if mode == "cancelled" && call == 3 {
					cancel()
				}
				if mode == "service-error" {
					return false, context.DeadlineExceeded
				}
				return mode == "initial-running" || (mode == "late-running" && call >= 4), nil
			}}
			var output bytes.Buffer
			var writer io.Writer = &output
			if mode == "writer-error" {
				writer = &backupFailWriter{}
			}
			err := RunCLI(ctx, []string{"export", "--data-dir", data, "--workspace-root", workspace, "--source-id", "isolated"}, errorReader{}, writer, CLIOptions{AppVersion: "0.4.7-beta.20", Service: service})
			if mode == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				archive, err := ValidateArchive(t.Context(), bytes.NewReader(output.Bytes()), t.TempDir())
				if err != nil || ValidateWorkerBackup(t.Context(), archive) != nil {
					t.Fatal("successful CLI produced unrestorable archive")
				}
			} else if err == nil || (mode != "writer-error" && output.Len() != 0) {
				t.Fatal("unconfirmed offline/cancelled export emitted bytes")
			}
			raw, err := os.ReadFile(filepath.Join(data, "state.json"))
			if err != nil || string(raw) != cliFixtureState || service.starts != 0 {
				t.Fatal("export changed source or started execution")
			}
		})
	}
}

func TestBackupCLIPreflightDoesNotConsultOrStartService(t *testing.T) {
	data, workspace := cliRoots(t)
	service := &cliServiceFixture{check: func(int) (bool, error) { return true, nil }}
	var output bytes.Buffer
	args := []string{"preflight", "--data-dir", data, "--workspace-root", workspace, "--source-id", "isolated"}
	if err := RunCLI(t.Context(), args, errorReader{}, &output, CLIOptions{Service: service}); err != nil {
		t.Fatal(err)
	}
	var footprint WorkerFootprint
	if json.Unmarshal(output.Bytes(), &footprint) != nil || footprint.Files != 1 || service.checks != 0 || service.starts != 0 {
		t.Fatal("read-only preflight acquired execution/service ownership")
	}
	if err := RunCLI(t.Context(), args, errorReader{}, &backupFailWriter{}, CLIOptions{Service: service}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("preflight writer failure ignored")
	}
}
