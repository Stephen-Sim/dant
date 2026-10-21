package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkerCLIRejectsFailedRestoreRecoveryAndInvalidReceiptEvidenceWithoutOutput(t *testing.T) {
	for _, command := range []string{"restore", "recover", "inspect", "outcome"} {
		t.Run(command, func(t *testing.T) {
			data, workspace := cliRoots(t)
			options := RestoreOptions{DataDir: data, WorkspaceRoot: workspace, RestoreID: testRestoreID}
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			if command != "restore" {
				name := locations.journal
				if command == "inspect" {
					name = filepath.Join(data, WorkerRestoreReceiptFile)
				} else if command == "outcome" {
					name = locations.rejection
				}
				if err := os.WriteFile(name, []byte("invalid retained receipt"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			service := &cliServiceFixture{}
			var output bytes.Buffer
			err = RunCLI(t.Context(), []string{command, "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID}, bytes.NewReader([]byte("invalid private archive")), &output, CLIOptions{Service: service})
			if err == nil || output.Len() != 0 || service.starts != 0 {
				t.Fatal("failed maintenance emitted a success receipt or started execution", err)
			}
			if raw, err := os.ReadFile(filepath.Join(data, "state.json")); err != nil || string(raw) != cliFixtureState {
				t.Fatal("failed maintenance replaced the original conversation", err)
			}
		})
	}
}

func TestWorkerCLIPreflightRejectsMissingDataBeforeAnyServiceOrArchiveOutput(t *testing.T) {
	data, workspace := cliRoots(t)
	service := &cliServiceFixture{}
	var output bytes.Buffer
	err := RunCLI(t.Context(), []string{"preflight", "--data-dir", filepath.Join(data, "missing"), "--workspace-root", workspace, "--source-id", "isolated"}, errorReader{}, &output, CLIOptions{Service: service})
	if !errors.Is(err, ErrInvalid) || output.Len() != 0 || service.checks != 0 || service.starts != 0 {
		t.Fatal("invalid preflight reached service control or published an estimate", err)
	}
}

func TestWorkerCLIReadOnlyInspectionUsesNoServiceForTheDefaultAdapter(t *testing.T) {
	data, workspace := cliRoots(t)
	var output bytes.Buffer
	if err := RunCLI(t.Context(), []string{"inspect", "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID}, errorReader{}, &output); err != nil {
		t.Fatal("read-only inspection consulted a live service instead of saved receipts", err)
	}
	if !bytes.Contains(output.Bytes(), []byte(`"restored":false`)) {
		t.Fatal("read-only inspection invented a restored result")
	}
}

func TestVMBackupRejectionChecksExactTargetAndPreservesUnknownTransportFailure(t *testing.T) {
	transport, _, binding, target := vmBackupFixture(t)
	if rejected, err := transport.Rejected(t.Context(), "invalid", target); !errors.Is(err, ErrInvalid) || rejected {
		t.Fatal("invalid restore identifier reached the transport", err)
	}
	binding.Host = "192.0.2.55"
	if rejected, err := transport.Rejected(t.Context(), testRestoreID, target); !errors.Is(err, ErrConnectionChanged) || rejected {
		t.Fatal("rejection receipt was requested from a replacement connection", err)
	}
	binding.Host = "192.0.2.1"
	calls := 0
	transport.options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls++
		return nil, io.ErrUnexpectedEOF
	}
	if rejected, err := transport.Rejected(t.Context(), testRestoreID, target); !errors.Is(err, ErrRestoreUnconfirmed) || rejected || calls != 1 {
		t.Fatal("unknown rejection result was acknowledged or repeated", err)
	}
}
