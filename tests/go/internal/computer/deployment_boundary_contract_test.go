package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func deploymentContractOptions(t *testing.T) (DeploymentOptions, Binding, BundleManifest, string) {
	t.Helper()
	root, manifest, fingerprint := deploymentBundleFixture(t)
	_, directory := ownedLifecycleFixture(t, nil)
	binding, err := ReadBinding(directory)
	if err != nil {
		t.Fatal(err)
	}
	network, _ := config.ReadNetwork(nil)
	return DeploymentOptions{
		Context: t.Context(), ProjectRoot: root, DataDir: directory,
		Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network,
		Binding:   func() (Binding, error) { return binding, nil },
		Quiescent: func(context.Context) error { return nil },
	}, binding, manifest, fingerprint
}

func obsoleteDeploymentProof(t *testing.T, manifest BundleManifest) []byte {
	t.Helper()
	sha := strings.Repeat("b", 64)
	raw, err := json.Marshal(deployedSource{SHA256: &sha, Active: true, Version: &manifest.Version})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestDeployerRejectsInvalidAssemblyAndDefaultsDoNotLaunchProcesses(t *testing.T) {
	root := t.TempDir()
	for _, options := range []DeploymentOptions{
		{ProjectRoot: root, DataDir: root, Version: "fixture"},
		{Context: t.Context(), ProjectRoot: "relative", DataDir: root, Version: "fixture"},
		{Context: t.Context(), ProjectRoot: root, DataDir: "relative", Version: "fixture"},
		{Context: t.Context(), ProjectRoot: root, DataDir: root},
	} {
		if _, err := NewDeployer(options); !errors.Is(err, ErrDeploymentUnavailable) {
			t.Fatal("invalid deployer assembly was accepted", err)
		}
	}
	deployer, err := NewDeployer(DeploymentOptions{Context: t.Context(), ProjectRoot: root, DataDir: root, Version: "fixture"})
	if err != nil || deployer.Status().Status != contracts.ServiceUpdateStatusPending {
		t.Fatal("constructing a default deployer executed a remote operation", err)
	}
}

func TestDeploymentRejectsUntrustedRemoteProofBeforeAnyMutation(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		err  error
	}{
		{"transport", "", io.ErrUnexpectedEOF},
		{"oversized", strings.Repeat("x", 4097), nil},
		{"malformed", `{`, nil},
		{"wrong shape", `[]`, nil},
		{"unknown field", `{"sha256":null,"active":false,"version":null,"session":null,"extra":true}`, nil},
		{"missing field", `{"sha256":null,"active":false,"version":null}`, nil},
		{"wrong hash", `{"sha256":"invalid","active":false,"version":null,"session":null}`, nil},
		{"empty version", `{"sha256":null,"active":false,"version":"","session":null}`, nil},
		{"long version", `{"sha256":null,"active":false,"version":"` + strings.Repeat("v", 65) + `","session":null}`, nil},
		{"unknown active", `{"sha256":null,"active":null,"version":null,"session":null}`, nil},
		{"foreign session", `{"sha256":null,"active":true,"version":null,"session":{"product":"foreign","mode":"worker","runtime":"go","protocol":1,"version":"fixture","source":"` + strings.Repeat("a", 40) + `"}}`, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			options, binding, _, _ := deploymentContractOptions(t)
			var calls, uploads atomic.Int32
			options.Run = func(context.Context, string, []string, io.Reader) ([]byte, error) {
				calls.Add(1)
				return []byte(test.raw), test.err
			}
			options.Quiescent = func(context.Context) error {
				uploads.Add(1)
				return nil
			}
			deployer, _ := NewDeployer(options)
			if err := deployer.Prepare(t.Context(), binding); err == nil || calls.Load() != 1 || uploads.Load() != 0 {
				t.Fatal("untrusted remote proof reached the cutover boundary", err)
			}
			if _, err := os.Stat(filepath.Join(options.DataDir, "vm-update-attempts.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("a rejected observation became an attempted deployment", err)
			}
		})
	}
}

func TestDeploymentCorruptAttemptHistoryCannotAuthorizeAnInstallerReplay(t *testing.T) {
	for _, raw := range []string{
		`{`, `[]`, `{"schemaVersion":2,"entries":[]}`, `{"schemaVersion":1,"entries":null}`,
		`{"schemaVersion":1,"entries":[{"binding":"invalid","source":"invalid"}]}`,
		`{"schemaVersion":1,"entries":[],"entries":[]}`,
	} {
		options, binding, manifest, _ := deploymentContractOptions(t)
		file := filepath.Join(options.DataDir, "vm-update-attempts.json")
		if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		var uploads atomic.Int32
		options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
			if input != nil {
				uploads.Add(1)
			}
			return obsoleteDeploymentProof(t, manifest), nil
		}
		deployer, _ := NewDeployer(options)
		if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads.Load() != 0 {
			t.Fatal("invalid durable deployment history permitted an install", err)
		}
		if after, err := os.ReadFile(file); err != nil || string(after) != raw {
			t.Fatal("unknown deployment evidence was overwritten", err)
		}
	}
}

func TestDeploymentInspectsRemoteQuiescenceWhenNoLocalBarrierIsAvailable(t *testing.T) {
	for _, variant := range []string{"safe", "active", "malformed", "oversized", "transport"} {
		t.Run(variant, func(t *testing.T) {
			options, binding, manifest, fingerprint := deploymentContractOptions(t)
			options.Quiescent = nil
			uploads, observations := 0, 0
			options.Run = func(_ context.Context, _ string, args []string, input io.Reader) ([]byte, error) {
				if input != nil {
					uploads++
					_, err := io.Copy(io.Discard, input)
					return nil, err
				}
				if args[len(args)-1] == inspectWorkerQuiescence {
					observations++
					state := bridgeStateFixture()
					switch variant {
					case "active":
						state.Queue = []string{"pending-work"}
					case "malformed":
						return []byte(`{`), nil
					case "oversized":
						return []byte(strings.Repeat("x", vmStateMaxBytes+1)), nil
					case "transport":
						return nil, io.ErrUnexpectedEOF
					}
					return json.Marshal(state)
				}
				if uploads > 0 {
					return json.Marshal(deployedSource{SHA256: &fingerprint, Active: true, Version: &manifest.Version, Session: deploymentSessionFixture(manifest)})
				}
				return obsoleteDeploymentProof(t, manifest), nil
			}
			deployer, _ := NewDeployer(options)
			err := deployer.Prepare(t.Context(), binding)
			if variant == "safe" {
				if err != nil || uploads != 1 || observations != 1 || !deployer.Status().Confirmed {
					t.Fatal("independently safe remote worker could not perform one verified cutover", err)
				}
			} else if !errors.Is(err, ErrDeploymentDeferred) || uploads != 0 || observations != 1 || deployer.Status().Reason == nil || *deployer.Status().Reason != "work-active" {
				t.Fatal("unsafe or unknown remote execution permitted a deployment", err)
			}
		})
	}
}

func TestDeploymentBindingChangeAndLocalBarrierFailurePreventUnownedCutovers(t *testing.T) {
	for _, variant := range []string{"initial binding", "binding after inspection", "binding after upload", "local pause", "missing stage directory"} {
		t.Run(variant, func(t *testing.T) {
			options, binding, manifest, _ := deploymentContractOptions(t)
			current := binding
			options.Binding = func() (Binding, error) { return current, nil }
			uploads := 0
			options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
				if input != nil {
					uploads++
					if variant == "binding after upload" {
						current.Host = "replacement.invalid"
					}
					return nil, nil
				}
				if variant == "binding after inspection" {
					current.Host = "replacement.invalid"
				}
				return obsoleteDeploymentProof(t, manifest), nil
			}
			want := ErrBridgeChanged
			switch variant {
			case "initial binding":
				current.Host = "replacement.invalid"
			case "local pause":
				options.Quiescent = func(context.Context) error { return ErrPauseUnconfirmed }
				want = ErrDeploymentDeferred
			case "missing stage directory":
				options.DataDir = filepath.Join(t.TempDir(), "missing")
				want = ErrDeploymentUnavailable
			}
			deployer, _ := NewDeployer(options)
			if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, want) || (uploads > 0 && variant != "binding after upload") {
				t.Fatal("a changed owner or incomplete local barrier authorized installation", err)
			}
			if variant == "binding after upload" {
				raw, err := os.ReadFile(filepath.Join(options.DataDir, "vm-update-attempts.json"))
				if err != nil || !strings.Contains(string(raw), BindingDigest(binding)) || deployer.Status().Confirmed {
					t.Fatal("post-upload identity loss erased its durable unknown outcome", err)
				}
			}
		})
	}
}

func TestBundleValidationRejectsMalformedInventoryAndUnauthenticatedMembers(t *testing.T) {
	for _, variant := range []string{
		"missing manifest", "invalid json", "wrong version", "wrong source", "wrong schema", "empty inventory", "duplicate member",
		"zero bytes", "oversized member", "total capacity", "bad hash", "extra entry property", "missing member", "directory member", "hardlinked member",
	} {
		t.Run(variant, func(t *testing.T) {
			root, manifest, _ := deploymentBundleFixture(t)
			manifestFile := filepath.Join(root, filepath.FromSlash(BundleManifestPath))
			member := filepath.Join(root, filepath.FromSlash(GuestBinaryPath))
			switch variant {
			case "missing manifest":
				_ = os.Remove(manifestFile)
			case "invalid json":
				_ = os.WriteFile(manifestFile, []byte(`{`), 0600)
			case "wrong version":
				manifest.Version = "different-version"
			case "wrong source":
				manifest.SourceCommit = strings.Repeat("b", 40)
			case "wrong schema":
				manifest.SchemaVersion = 2
			case "empty inventory":
				manifest.Files = nil
			case "duplicate member":
				manifest.Files = append(manifest.Files, manifest.Files[0])
			case "zero bytes":
				manifest.Files[0].Bytes = 0
			case "oversized member":
				manifest.Files[0].Bytes = bundleFileLimit + 1
			case "total capacity":
				for index := range 3 {
					manifest.Files[index].Bytes = bundleFileLimit
				}
			case "bad hash":
				manifest.Files[0].SHA256 = "invalid"
			case "missing member":
				_ = os.Remove(member)
			case "directory member":
				_ = os.Remove(member)
				_ = os.Mkdir(member, 0700)
			case "hardlinked member":
				if err := os.Link(member, filepath.Join(root, "second-link")); err != nil {
					t.Fatal("isolated hardlink fixture unavailable", err)
				}
			}
			if variant != "missing manifest" && variant != "invalid json" {
				raw, _ := json.Marshal(manifest)
				if variant == "extra entry property" {
					var object map[string]json.RawMessage
					_ = json.Unmarshal(raw, &object)
					var entries []map[string]json.RawMessage
					_ = json.Unmarshal(object["files"], &entries)
					entries[0]["untrusted"] = json.RawMessage(`true`)
					object["files"], _ = json.Marshal(entries)
					raw, _ = json.Marshal(object)
				}
				if err := os.WriteFile(manifestFile, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err := VerifyBundle(t.Context(), root, "0.4.7-beta.12", strings.Repeat("a", 40)); !errors.Is(err, ErrDeploymentUnavailable) {
				t.Fatal("unverified bundle bytes or inventory were accepted", err)
			}
		})
	}
}
