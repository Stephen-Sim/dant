package backups

import (
	"errors"
	"testing"
)

func TestWindowsCannotClaimAWorkerIsOfflineFromAnUnrelatedHost(t *testing.T) {
	if err := AssertWorkerOffline(t.Context(), t.TempDir(), t.TempDir()); !errors.Is(err, ErrBusy) {
		t.Fatal("Windows claimed a Linux worker offline without process ownership proof", err)
	}
}
