package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

func TestDeploymentCleanupPreservesAReplacedStagingDirectoryAfterUnknownInstallResult(t *testing.T) {
	root, manifest, _ := deploymentBundleFixture(t)
	_, directory := ownedLifecycleFixture(t, nil)
	binding, err := ReadBinding(directory)
	if err != nil {
		t.Fatal(err)
	}
	network, err := config.ReadNetwork(nil)
	if err != nil {
		t.Fatal(err)
	}
	marker := ""
	retained := ""
	uploads := 0
	run := func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
		if input == nil {
			return json.Marshal(deployedSource{Active: false})
		}
		uploads++
		file, ok := input.(*os.File)
		if !ok {
			t.Fatal("deployment did not upload its exclusively opened private archive")
		}
		stage := filepath.Dir(file.Name())
		if _, err := io.Copy(io.Discard, file); err != nil {
			t.Fatal(err)
		}
		// Model replacement after the completed upload releases the archive
		// handle, before the outer owner performs its deferred directory cleanup.
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		retained = stage + "-original"
		if err := os.Rename(stage, retained); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(stage, 0700); err != nil {
			t.Fatal(err)
		}
		marker = filepath.Join(stage, "unrelated.bin")
		if err := os.WriteFile(marker, []byte("replacement must survive"), 0600); err != nil {
			t.Fatal(err)
		}
		return nil, io.ErrUnexpectedEOF
	}
	deployer, err := NewDeployer(DeploymentOptions{
		Context: t.Context(), ProjectRoot: root, DataDir: directory,
		Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network,
		Binding: func() (Binding, error) { return binding, nil }, Run: run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
		t.Fatal("unknown deployment result was retried or reported confirmed", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "replacement must survive" {
		t.Fatal("deferred cleanup adopted and removed an unrelated replacement directory", err)
	}
	if _, err := os.Stat(filepath.Join(retained, "source.tar")); err != nil {
		t.Fatal("unknown deployment lost its independently retained archive", err)
	}
	if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
		t.Fatal("unconfirmed deployment was replayed before reconciling source identity", err)
	}
}
