package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyBundleAuthenticatesContentsAndHonorsCancellation(t *testing.T) {
	root, manifest, _ := deploymentBundleFixture(t)
	if _, _, err := VerifyBundle(context.Background(), root, manifest.Version, manifest.SourceCommit); err != nil {
		t.Fatal(err)
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := VerifyBundle(canceled, root, manifest.Version, manifest.SourceCommit); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was not preserved")
	}
	name := filepath.Join(root, filepath.FromSlash(GuestBinaryPath))
	before, _ := os.ReadFile(name)
	before[0] ^= 1
	if err := os.WriteFile(name, before, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := VerifyBundle(context.Background(), root, manifest.Version, manifest.SourceCommit); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("modified executable was accepted")
	}
}
