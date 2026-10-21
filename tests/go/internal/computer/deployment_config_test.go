package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

func TestDeploymentRejectsConflictingGuestConfigurationBeforeCreatingArchive(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	protocol := config.DefaultProtocol()
	for _, port := range []int{0, protocol.APIPort, protocol.BootstrapGuestPort, config.MaxPort + 1} {
		network, err := config.ReadNetwork(nil)
		if err != nil {
			t.Fatal(err)
		}
		network.Guest.Port = port
		target := filepath.Join(t.TempDir(), "unwritten.tar")
		if err := writeBundleTar(context.Background(), root, target, manifest, nil, fingerprint, network); !errors.Is(err, ErrDeploymentUnavailable) {
			t.Fatal("invalid deployment settings accepted", port, err)
		}
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("invalid deployment wrote an archive", err)
		}
	}

	network, err := config.ReadNetwork(nil)
	if err != nil {
		t.Fatal(err)
	}
	network.Guest.Host = "remote.invalid"
	target := filepath.Join(t.TempDir(), "existing.tar")
	if err := os.WriteFile(target, []byte("previous verified archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeBundleTar(context.Background(), root, target, manifest, nil, fingerprint, network); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("untrusted deployment host accepted", err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "previous verified archive" {
		t.Fatal("invalid settings changed an existing archive", err)
	}
}
