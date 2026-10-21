package computer

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestLinuxProvisioningRejectsALinkedDataDirectoryBeforeWritingOrLaunchingHelpers(t *testing.T) {
	options := provisioningContractOptions(t)
	outside := t.TempDir()
	marker := filepath.Join(outside, "retained.txt")
	if err := os.WriteFile(marker, []byte("unrelated fixture directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, options.DataDir); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
		calls.Add(1)
		return nil, ErrProvisioningFailed
	}
	provisioning, err := NewProvisioning(options)
	if err != nil {
		t.Fatal(err)
	}
	defer provisioning.Close()
	if _, err := provisioning.Start(t.Context(), []byte(`{"provider":"hyperv"}`)); !errors.Is(err, ErrBinding) || calls.Load() != 0 || provisioning.Snapshot().Running {
		t.Fatal("linked storage admitted a helper or retained a running owner", err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 || entries[0].Name() != "retained.txt" {
		t.Fatal("rejected linked storage modified its target", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "unrelated fixture directory" {
		t.Fatal("rejected linked storage changed unrelated data", err)
	}
}
