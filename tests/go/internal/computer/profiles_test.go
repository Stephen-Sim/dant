package computer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func profileFixture(t *testing.T, host string) string {
	t.Helper()
	_, directory := ownedLifecycleFixture(t, nil)
	binding, err := ReadBinding(directory)
	if err != nil {
		t.Fatal(err)
	}
	binding.Host = host
	raw, _ := json.Marshal(binding)
	if os.WriteFile(filepath.Join(directory, "vm.json"), raw, 0600) != nil {
		t.Fatal("fixture binding")
	}

	return directory
}

func TestProfilesNeverReplaceConfiguredComputerImplicitly(t *testing.T) {
	current := profileFixture(t, "current.invalid")
	candidate := profileFixture(t, "candidate.invalid")
	root := t.TempDir()
	profiles, err := NewProfiles(ProfileOptions{DataDir: current, ProjectRoot: root, RegistryFile: filepath.Join(root, "registry.json"), Owner: "isolated-owner", CandidateDirs: []string{candidate}})
	if err != nil {
		t.Fatal(err)
	}
	discovery, err := profiles.AutoImport(context.Background())
	if err != nil || discovery.Current == nil || discovery.Current.Host != "current.invalid" || len(discovery.Candidates) != 1 {
		t.Fatal("configured connection was replaced")
	}

	if _, err := profiles.Import(context.Background(), ProfileImport{Directory: candidate}); err == nil {
		t.Fatal("replacement admitted without explicit choice")
	}
	result, err := profiles.Import(context.Background(), ProfileImport{Directory: candidate, ReplaceCurrent: true})
	if err != nil || !result.OK {
		t.Fatal(err)
	}
	binding, _ := ReadBinding(current)
	if binding.Host != "candidate.invalid" {
		t.Fatal("explicit profile import failed")
	}
	previous, err := filepath.Glob(filepath.Join(current, "vm.json.previous-*.bak"))
	if err != nil || len(previous) != 1 {
		t.Fatal("original connection not retained")
	}
}

func TestProfilesIgnoreForeignRegistryAndRequireSelectionForMultipleCandidates(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "empty")
	os.Mkdir(data, 0700)
	registry := filepath.Join(root, "registry.json")
	os.WriteFile(registry, []byte(`{"version":1,"owner":"another-owner","profiles":[]}`), 0600)
	first := profileFixture(t, "first.invalid")
	second := profileFixture(t, "second.invalid")
	profiles, _ := NewProfiles(ProfileOptions{DataDir: data, ProjectRoot: root, RegistryFile: registry, Owner: "current-owner", CandidateDirs: []string{first, second}})
	discovery, err := profiles.AutoImport(context.Background())
	if err != nil || !discovery.RequiresSelection || discovery.Current != nil || discovery.RegistryError == nil {
		t.Fatal("ambiguous or foreign profile was selected implicitly")
	}
	raw, _ := os.ReadFile(registry)
	if string(raw) != `{"version":1,"owner":"another-owner","profiles":[]}` {
		t.Fatal("foreign registry overwritten")
	}
}
