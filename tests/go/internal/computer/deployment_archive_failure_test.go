package computer

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

type deploymentArchiveSink struct {
	output bytes.Buffer
	writes int
	failAt int
	short  bool
}

func (sink *deploymentArchiveSink) Write(raw []byte) (int, error) {
	sink.writes++
	if sink.writes == sink.failAt {
		if sink.short {
			count := len(raw) / 2
			_, _ = sink.output.Write(raw[:count])
			return count, io.ErrShortWrite
		}
		return 0, io.ErrClosedPipe
	}
	return sink.output.Write(raw)
}

func TestDeploymentArchiveRejectsEveryPartialHeaderBodyManifestAndFinalizationWrite(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, canonical, err := readBundle(root, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}
	public, err := config.PublicVMConfiguration(nil)
	if err != nil {
		t.Fatal(err)
	}
	baseline := &deploymentArchiveSink{}
	if err := writeBundleArchive(t.Context(), root, baseline, manifest, canonical, fingerprint, public); err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(bytes.NewReader(baseline.output.Bytes()))
	entries := 0
	for {
		_, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal("successful archive was not complete", err)
		}
		entries++
		if _, err := io.Copy(io.Discard, reader); err != nil {
			t.Fatal(err)
		}
	}
	if entries != len(manifest.Files)+2 {
		t.Fatal("successful archive omitted verified files or deployment manifests")
	}
	for write := 1; write <= baseline.writes; write++ {
		for _, short := range []bool{false, true} {
			t.Run(fmt.Sprintf("write-%d/short-%t", write, short), func(t *testing.T) {
				sink := &deploymentArchiveSink{failAt: write, short: short}
				if err := writeBundleArchive(t.Context(), root, sink, manifest, canonical, fingerprint, public); err == nil || sink.writes != write {
					t.Fatal("partial archive was reported complete or its failed write was retried", err)
				}
			})
		}
	}
	if _, _, err := VerifyBundle(t.Context(), root, manifest.Version, manifest.SourceCommit); err != nil {
		t.Fatal("failed deployment output modified authenticated source files", err)
	}
}

func TestDeploymentArchiveRejectsChangedSourcesAndDoesNotCreateInvalidConfigurationTargets(t *testing.T) {
	for _, mode := range []string{"missing-parent", "missing-file", "changed-bytes", "hard-linked"} {
		t.Run(mode, func(t *testing.T) {
			root, manifest, fingerprint := deploymentBundleFixture(t)
			_, canonical, err := readBundle(root, manifest.Version, manifest.SourceCommit)
			if err != nil {
				t.Fatal(err)
			}
			public, err := config.PublicVMConfiguration(nil)
			if err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(root, filepath.FromSlash(manifest.Files[0].Path))
			switch mode {
			case "missing-parent":
				if err := os.Rename(filepath.Dir(name), filepath.Dir(name)+"-retained"); err != nil {
					t.Fatal(err)
				}
			case "missing-file":
				if err := os.Rename(name, name+"-retained"); err != nil {
					t.Fatal(err)
				}
			case "changed-bytes":
				raw, err := os.ReadFile(name)
				if err != nil || len(raw) == 0 {
					t.Fatal("source fixture is empty", err)
				}
				raw[0] ^= 1
				if err := os.WriteFile(name, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "hard-linked":
				if err := os.Link(name, filepath.Join(t.TempDir(), "foreign-source")); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			if err := writeBundleArchive(t.Context(), root, &output, manifest, canonical, fingerprint, public); !errors.Is(err, ErrDeploymentUnavailable) {
				t.Fatal("changed verified source was archived as a complete deployment", err)
			}
		})
	}
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, canonical, err := readBundle(root, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "must-not-be-created.tar")
	invalid := config.Network{}
	invalid.Guest.Host = "non-loopback.invalid"
	if err := writeBundleTar(t.Context(), root, target, manifest, canonical, fingerprint, invalid); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("invalid public configuration reached archive creation", err)
	}
	if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid configuration created a partial deployment archive", err)
	}
}
