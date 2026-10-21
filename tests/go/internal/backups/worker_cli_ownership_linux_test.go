package backups

import (
	"bytes"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func TestLinuxMaintenanceCannotBorrowAnExistingWorkerDataLease(t *testing.T) {
	for _, command := range []string{"restore", "recover", "export"} {
		t.Run(command, func(t *testing.T) {
			data, workspace := cliRoots(t)
			owner, err := ownership.Acquire(t.Context(), data)
			if err != nil {
				t.Fatal(err)
			}
			defer owner.Close()
			args := []string{command, "--data-dir", data, "--workspace-root", workspace}
			if command == "export" {
				args = append(args, "--source-id", "isolated-maintenance")
			} else {
				args = append(args, "--restore-id", testRestoreID)
			}
			service := &cliServiceFixture{}
			input := &restoreReadCounter{}
			var output bytes.Buffer
			if err := RunCLI(t.Context(), args, input, &output, CLIOptions{Service: service}); !errors.Is(err, ErrBusy) || input.reads != 0 || output.Len() != 0 || service.starts != 0 || !owner.Current() {
				t.Fatal("maintenance adopted or retired another live worker lease", err)
			}
			if err := owner.Close(); err != nil {
				t.Fatal(err)
			}
			next, err := ownership.Acquire(t.Context(), data)
			if err != nil {
				t.Fatal("failed maintenance left an extra data owner", err)
			}
			if err := next.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
