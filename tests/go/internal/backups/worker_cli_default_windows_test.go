package backups

import (
	"bytes"
	"errors"
	"testing"
)

func TestWindowsDefaultMaintenanceCannotClaimALinuxWorkerIsOffline(t *testing.T) {
	for _, command := range []string{"restore", "recover"} {
		data, workspace := cliRoots(t)
		var output bytes.Buffer
		err := RunCLI(t.Context(), []string{command, "--data-dir", data, "--workspace-root", workspace, "--restore-id", testRestoreID}, errorReader{}, &output)
		if !errors.Is(err, ErrBusy) || output.Len() != 0 {
			t.Fatal("Windows default maintenance claimed a Linux offline lease", command, err)
		}
	}
}
