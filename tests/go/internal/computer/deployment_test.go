package computer

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/security"
)

func deploymentBundleFixture(t *testing.T) (string, BundleManifest, string) {
	t.Helper()
	root := t.TempDir()
	manifest := BundleManifest{SchemaVersion: 1, Version: "0.4.7-beta.12", SourceCommit: strings.Repeat("a", 40)}
	for _, name := range []string{
		GuestBinaryPath,
		"vm/install-worker.sh",
		"vm/worker-install.py",
		"vm/guest.py",
		"vm/control.py",
		"vm/desktop.py",
		"vm/desktop_mcp.py",
		"vm/start-codex.sh",
		"vm/transcribe_audio.py",
		"vm/voice_message.py",
		config.ProtocolResourcePath,
	} {
		value := []byte("isolated bundle " + name + "\x00\xff")
		target := filepath.Join(root, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(target), 0700)
		if err := os.WriteFile(target, value, 0600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(value)
		manifest.Files = append(manifest.Files, BundleFile{Path: name, Bytes: int64(len(value)), SHA256: hex.EncodeToString(sum[:])})
	}
	raw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(BundleManifestPath)), raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, normalized, err := readBundle(root, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(normalized)
	return root, manifest, hex.EncodeToString(sum[:])
}

func deploymentSessionFixture(manifest BundleManifest) *deployedWorkerSession {
	return &deployedWorkerSession{
		Product: "dant", Mode: "worker", Runtime: security.CoreRuntime,
		Protocol: security.CoreProtocolVersion, Version: manifest.Version, Source: manifest.SourceCommit,
	}
}

func TestDeploymentTransfersOnlyVerifiedGoBundleAndConfirmsExactSource(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, directory := ownedLifecycleFixture(t, nil)
	binding, _ := ReadBinding(directory)
	network, _ := config.ReadNetwork(nil)
	uploads := 0
	installed := false
	run := func(ctx context.Context, exe string, args []string, input io.Reader) ([]byte, error) {
		if exe != "ssh" {
			t.Fatal("deployment invoked an unexpected host command")
		}
		if input == nil {
			sha := strings.Repeat("b", 64)
			var session *deployedWorkerSession // The pre-update legacy Node has no Go marker.
			if installed {
				sha = fingerprint
				session = deploymentSessionFixture(manifest)
			}
			raw, _ := json.Marshal(deployedSource{SHA256: &sha, Active: true, Version: &manifest.Version, Session: session})
			return raw, nil
		}
		uploads++
		archive := tar.NewReader(input)
		seen := map[string]bool{}
		for {
			header, err := archive.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if header.Typeflag != tar.TypeReg {
				t.Fatal("nonordinary bundle member")
			}
			seen[header.Name] = true
			if strings.Contains(header.Name, "node") || strings.Contains(header.Name, ".env") {
				t.Fatal("legacy runtime or credentials entered bundle")
			}
			io.Copy(io.Discard, archive)
		}
		if !seen[GuestBinaryPath] || !seen[BundleManifestPath] || !seen["deploy-manifest.json"] {
			t.Fatal("bundle provenance missing")
		}
		installed = true
		return nil, nil
	}
	deployer, err := NewDeployer(DeploymentOptions{Context: context.Background(), ProjectRoot: root, DataDir: directory, Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network, Binding: func() (Binding, error) { return binding, nil }, Run: run, Quiescent: func(context.Context) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}

	if err := deployer.Prepare(context.Background(), binding); err != nil {
		t.Fatal(err)
	}

	if uploads != 1 || !deployer.Status().Confirmed {
		t.Fatal("deployment was not confirmed")
	}

	if err := deployer.Prepare(context.Background(), binding); err != nil || uploads != 1 {
		t.Fatal("current source was installed again")
	}
}

func TestUnconfirmedDeploymentReconcilesReadonlyWithoutReplayingInstaller(t *testing.T) {
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, directory := ownedLifecycleFixture(t, nil)
	binding, _ := ReadBinding(directory)
	network, _ := config.ReadNetwork(nil)
	uploads := 0
	confirmed := false
	run := func(ctx context.Context, exe string, args []string, input io.Reader) ([]byte, error) {
		if input != nil {
			uploads++
			return nil, io.ErrUnexpectedEOF
		}
		sha := strings.Repeat("b", 64)
		var session *deployedWorkerSession
		if confirmed {
			sha = fingerprint
			session = deploymentSessionFixture(manifest)
		}
		raw, _ := json.Marshal(deployedSource{SHA256: &sha, Active: true, Version: &manifest.Version, Session: session})
		return raw, nil
	}
	options := DeploymentOptions{Context: context.Background(), ProjectRoot: root, DataDir: directory, Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network, Binding: func() (Binding, error) { return binding, nil }, Run: run, Quiescent: func(context.Context) error { return nil }}
	deployer, _ := NewDeployer(options)
	if err := deployer.Prepare(context.Background(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) {
		t.Fatal("unknown installer outcome was cleared")
	}
	restarted, _ := NewDeployer(options)
	if err := restarted.Prepare(context.Background(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
		t.Fatal("installer replayed after restart")
	}
	confirmed = true
	if err := restarted.Prepare(context.Background(), binding); err != nil || uploads != 1 || !restarted.Status().Confirmed {
		t.Fatal("known remote source did not reconcile readonly")
	}
}

func TestDeploymentRejectsChangedOrUnknownResourcesBeforeSSHMutation(t *testing.T) {
	root, manifest, _ := deploymentBundleFixture(t)
	_, directory := ownedLifecycleFixture(t, nil)
	binding, _ := ReadBinding(directory)
	network, _ := config.ReadNetwork(nil)
	uploads := 0
	run := func(context.Context, string, []string, io.Reader) ([]byte, error) {
		return []byte(`{"sha256":null,"active":false,"version":null,"session":null}`), nil
	}
	options := DeploymentOptions{Context: context.Background(), ProjectRoot: root, DataDir: directory, Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network, Binding: func() (Binding, error) { return binding, nil }, Run: func(ctx context.Context, exe string, args []string, input io.Reader) ([]byte, error) {
		if input != nil {
			uploads++
		}
		return run(ctx, exe, args, input)
	}}
	os.WriteFile(filepath.Join(root, filepath.FromSlash(GuestBinaryPath)), []byte("changed"), 0600)
	deployer, _ := NewDeployer(options)
	if err := deployer.Prepare(context.Background(), binding); !errors.Is(err, ErrDeploymentUnavailable) || uploads != 0 {
		t.Fatal("changed resource reached remote installer")
	}
	manifest.Files = append(manifest.Files, BundleFile{Path: ".env", Bytes: 1, SHA256: strings.Repeat("a", 64)})
	raw, _ := json.Marshal(manifest)
	os.WriteFile(filepath.Join(root, filepath.FromSlash(BundleManifestPath)), raw, 0600)
	if _, _, err := readBundle(root, manifest.Version, manifest.SourceCommit); !errors.Is(err, ErrDeploymentUnavailable) {
		t.Fatal("unknown resource allowed in bundle")
	}
}

func TestDeploymentRejectsMissingInstallerRequiredAudioHelpers(t *testing.T) {
	for _, missing := range []string{"vm/transcribe_audio.py", "vm/voice_message.py"} {
		t.Run(missing, func(t *testing.T) {
			root, manifest, _ := deploymentBundleFixture(t)
			entries := []BundleFile{}
			for _, file := range manifest.Files {
				if file.Path != missing {
					entries = append(entries, file)
				}
			}
			manifest.Files = entries
			raw, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(BundleManifestPath)), raw, 0o600); err != nil {
				t.Fatal(err)
			}

			if _, _, err := readBundle(root, manifest.Version, manifest.SourceCommit); !errors.Is(err, ErrDeploymentUnavailable) {
				t.Fatal("incomplete bundle passed host verification")
			}
		})
	}
}

func TestDeploymentRequiresMatchingLiveGoSourceAndNeverReplaysAnUnconfirmedCutover(t *testing.T) {
	for _, mode := range []string{"matching Go", "legacy Node", "wrong source", "wrong protocol", "wrong role", "wrong version", "wrong runtime"} {
		t.Run(mode, func(t *testing.T) {
			root, manifest, fingerprint := deploymentBundleFixture(t)
			_, directory := ownedLifecycleFixture(t, nil)
			binding, _ := ReadBinding(directory)
			network, _ := config.ReadNetwork(nil)
			uploads := 0
			options := DeploymentOptions{
				Context: t.Context(), ProjectRoot: root, DataDir: directory,
				Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network,
				Binding:   func() (Binding, error) { return binding, nil },
				Quiescent: func(context.Context) error { return nil },
				Run: func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
					if input != nil {
						uploads++
						return nil, nil
					}
					var session *deployedWorkerSession
					if uploads > 0 {
						session = deploymentSessionFixture(manifest)
						switch mode {
						case "legacy Node":
							session = nil
						case "wrong source":
							session.Source = strings.Repeat("b", 40)
						case "wrong protocol":
							session.Protocol++
						case "wrong role":
							session.Mode = "controller"
						case "wrong version":
							session.Version = "0.0.0-test.1"
						case "wrong runtime":
							session.Runtime = "node"
						}
					}
					// Even an existing matching manifest/version must not promote
					// the unmarked pre-update legacy process into Go ownership.
					return json.Marshal(deployedSource{
						SHA256: &fingerprint, Active: true, Version: &manifest.Version, Session: session,
					})
				},
			}
			deployer, err := NewDeployer(options)
			if err != nil {
				t.Fatal(err)
			}
			err = deployer.Prepare(t.Context(), binding)
			if mode == "matching Go" {
				if err != nil || uploads != 1 || !deployer.Status().Confirmed {
					t.Fatal("exact live Go identity was not confirmed", err)
				}
				return
			}
			if !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 || deployer.Status().Confirmed {
				t.Fatal("unconfirmed live identity was promoted", err)
			}
			restarted, _ := NewDeployer(options)
			if err := restarted.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
				t.Fatal("unknown cutover replayed its installer", err)
			}
		})
	}
}
