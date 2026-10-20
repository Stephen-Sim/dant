package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func profileManager(t *testing.T, options ProfileOptions) *Profiles {
	t.Helper()
	profiles, err := NewProfiles(options)
	if err != nil {
		t.Fatal(err)
	}
	return profiles
}

func TestProfilesImportByReferenceAndDiscoverOnlyTheSameOwnersRegistry(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "new-data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	source := profileFixture(t, "one.invalid")
	binding, _ := ReadBinding(source)
	for name, value := range map[string]string{"state.json": "private history", "vm-key": "unrelated target key", "vm-setup-status.json": "unrelated failed setup"} {
		target := data
		if name == "state.json" {
			target = source
		}
		if err := os.WriteFile(filepath.Join(target, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	registry := filepath.Join(root, "registry.json")
	previous := profileManager(t, ProfileOptions{DataDir: source, ProjectRoot: root, RegistryFile: registry, Owner: "same-owner"})
	if err := previous.RegisterCurrent(t.Context()); err != nil {
		t.Fatal(err)
	}
	profiles := profileManager(t, ProfileOptions{DataDir: data, ProjectRoot: root, RegistryFile: registry, Owner: "same-owner"})
	discovered := profiles.Discover()
	if len(discovered.Candidates) != 1 || discovered.Candidates[0].Source != "registry" || discovered.Current != nil {
		t.Fatal("the same account could not discover its registered connection")
	}
	result, err := profiles.AutoImport(t.Context())
	actual, readErr := ReadBinding(data)
	if err != nil || readErr != nil || result.Current == nil || actual.KeyPath != binding.KeyPath || actual.KnownHosts != binding.KnownHosts {
		t.Fatal("auto import copied credentials or failed to keep the original reference", err)
	}
	for name, expected := range map[string]string{"vm-key": "unrelated target key", "vm-setup-status.json": "unrelated failed setup"} {
		raw, err := os.ReadFile(filepath.Join(data, name))
		if err != nil || string(raw) != expected {
			t.Fatal("import replaced unrelated installation data", err)
		}
	}
	if _, err := os.Stat(filepath.Join(data, "state.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("profile discovery imported conversation state")
	}
	raw, _ := json.Marshal(discovered.Candidates[0])
	if bytes.Contains(raw, []byte("keyPath")) || bytes.Contains(raw, []byte("private history")) {
		t.Fatal("public profile metadata exposed credential or conversation content")
	}
	foreignData := filepath.Join(root, "foreign")
	_ = os.Mkdir(foreignData, 0700)
	foreign := profileManager(t, ProfileOptions{DataDir: foreignData, ProjectRoot: root, RegistryFile: registry, Owner: "different-owner"})
	if result := foreign.Discover(); len(result.Candidates) != 0 || result.RegistryError == nil {
		t.Fatal("a different account inherited another registry")
	}
}

func TestProfilesDeduplicateCanonicalConnectionsAndPreserveVMwareOwnership(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "empty")
	_ = os.Mkdir(data, 0700)
	source := profileFixture(t, "SAME.invalid")
	binding, _ := ReadBinding(source)
	binding.Provider = contracts.VmProviderIdVMware
	binding.Name = "  工作电脑  "
	binding.VMXPath = filepath.Join(root, "not-created", "computer.VMX")
	binding.VMwareID = "79C8D5A0-7E49-49C1-8248-F671BD891320"
	raw, _ := json.Marshal(binding)
	_ = os.WriteFile(filepath.Join(source, "vm.json"), raw, 0600)
	duplicate := filepath.Join(root, "duplicate")
	_ = os.Mkdir(duplicate, 0700)
	binding.Host = "same.invalid"
	raw, _ = json.Marshal(binding)
	_ = os.WriteFile(filepath.Join(duplicate, "vm.json"), raw, 0600)
	profiles := profileManager(t, ProfileOptions{
		DataDir: data, ProjectRoot: root, Owner: "fixture-owner",
		CandidateDirs: []string{source, source, duplicate, filepath.Join(root, "missing"), "relative", "invalid\x00directory"},
	})
	discovery := profiles.Discover()
	if len(discovery.Candidates) != 1 || discovery.RequiresSelection {
		t.Fatal("the same endpoint and canonical key became multiple choices")
	}
	imported, err := profiles.Import(t.Context(), ProfileImport{ID: discovery.Candidates[0].ID})
	if err != nil || !imported.OK || imported.Connected {
		t.Fatal("profile import connected an executor or failed", err)
	}
	for _, value := range []Profile{discovery.Candidates[0], imported.Profile, *profiles.Discover().Current} {
		if value.Provider != contracts.VmProviderIdVMware || value.Name != "工作电脑" || value.VMXPath != binding.VMXPath || value.VMwareID != strings.ToLower(binding.VMwareID) {
			t.Fatal("connection metadata or ownership changed during import")
		}
	}
	if _, err := os.Stat(binding.VMXPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("profile import opened or created a VMX file")
	}
	before, _ := os.ReadFile(filepath.Join(data, "vm.json"))
	for _, choice := range []ProfileImport{{ID: profiles.Discover().Current.ID}, {Directory: source}} {
		if result, err := profiles.Import(t.Context(), choice); err != nil || !result.OK || result.Connected {
			t.Fatal("selecting the existing connection was not a side-effect-free success", err)
		}
	}
	after, _ := os.ReadFile(filepath.Join(data, "vm.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("selecting the current profile rewrote it")
	}
}

func TestProfileSelectionRejectsMalformedAndStaleChoicesWithoutChangingConfiguration(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "target")
	_ = os.Mkdir(data, 0700)
	profiles := profileManager(t, ProfileOptions{DataDir: data, ProjectRoot: root, Owner: "fixture"})
	stale := profileFixture(t, "stale.invalid")
	binding, _ := ReadBinding(stale)
	_ = os.Remove(binding.KeyPath)
	for _, choice := range []ProfileImport{
		{}, {ID: "unknown"}, {ID: "unknown", Directory: stale},
		{Directory: "relative/path"}, {Directory: strings.Repeat("x", 4097)},
		{Directory: root + "\x00unexpected"}, {Directory: stale},
	} {
		if _, err := profiles.Import(t.Context(), choice); err == nil {
			t.Fatal("an ambiguous or stale selection was accepted")
		}
	}
	if _, err := os.Stat(filepath.Join(data, "vm.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid selection created a connection")
	}
	if err := profiles.RegisterCurrent(t.Context()); err == nil {
		t.Fatal("missing configuration was registered")
	}
}

func TestProfileImportPreservesInvalidOriginalBytesAndHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "target")
	_ = os.Mkdir(data, 0700)
	original := []byte("{broken original connection")
	_ = os.WriteFile(filepath.Join(data, "vm.json"), original, 0600)
	source := profileFixture(t, "selected.invalid")
	profiles := profileManager(t, ProfileOptions{DataDir: data, ProjectRoot: root, Owner: "fixture"})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := profiles.Import(ctx, ProfileImport{Directory: source}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled import replaced configuration", err)
	}
	current, _ := os.ReadFile(filepath.Join(data, "vm.json"))
	if !bytes.Equal(current, original) {
		t.Fatal("cancellation changed the original connection")
	}
	if _, err := profiles.Import(t.Context(), ProfileImport{Directory: source}); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(data, "vm.json.invalid-*.bak"))
	if len(backups) < 1 {
		t.Fatal("invalid original was discarded")
	}
	for _, name := range backups {
		raw, _ := os.ReadFile(name)
		if !bytes.Equal(raw, original) {
			t.Fatal("original connection evidence changed")
		}
	}
}

func TestProfileRegistryValidationAndBoundedRegistration(t *testing.T) {
	root := t.TempDir()
	source := profileFixture(t, "current.invalid")
	registry := filepath.Join(root, "registry.json")
	for _, raw := range []string{`{`, `[]`, `{"version":2,"owner":"fixture","profiles":[]}`, `{"version":1,"owner":"fixture","profiles":null}`} {
		_ = os.WriteFile(registry, []byte(raw), 0600)
		profiles := profileManager(t, ProfileOptions{DataDir: source, ProjectRoot: root, RegistryFile: registry, Owner: "fixture"})
		if result := profiles.Discover(); result.Current == nil || result.RegistryError == nil {
			t.Fatal("invalid registry concealed the configured connection")
		}
		if err := profiles.RegisterCurrent(t.Context()); err != nil {
			t.Fatal("registry corruption made an existing connection unusable", err)
		}
		after, _ := os.ReadFile(registry)
		if string(after) != raw {
			t.Fatal("invalid registry was silently overwritten")
		}
	}
	entries := []registryProfile{{Directory: "relative"}, {Directory: root + "\x00invalid"}}
	for index := range profileLimit + 3 {
		entries = append(entries, registryProfile{Directory: filepath.Join(root, strings.Repeat("x", index+1))})
	}
	raw, _ := json.Marshal(profileRegistry{Version: 1, Owner: "fixture", Profiles: entries})
	_ = os.WriteFile(registry, raw, 0600)
	candidates := make([]string, profileLimit+2)
	for index := range candidates {
		candidates[index] = source
	}
	profiles := profileManager(t, ProfileOptions{
		DataDir: source, ProjectRoot: root, RegistryFile: registry, Owner: "fixture",
		Now:           func() time.Time { return time.UnixMilli(123456789) },
		CandidateDirs: candidates, IncludeProject: true,
	})
	if err := profiles.RegisterCurrent(t.Context()); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(registry)
	var registered profileRegistry
	if json.Unmarshal(raw, &registered) != nil || len(registered.Profiles) != profileLimit || registered.Profiles[0].Directory != source || string(registered.Profiles[0].RegisteredAt) != "123456789" {
		t.Fatal("registration was not bounded or did not prioritize the current profile")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result, err := profiles.AutoImport(ctx); err != nil || result.Current == nil || result.RegistryError == nil {
		t.Fatal("a cancelled registry refresh discarded the current profile", err)
	}
}

func TestProfileImportRetainsTheCommittedConnectionWhenRegistryCancellationWins(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "target")
	registry := filepath.Join(root, "registry.json")
	source := profileFixture(t, "selected.invalid")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	profiles := profileManager(t, ProfileOptions{
		DataDir: data, ProjectRoot: root, RegistryFile: registry, Owner: "fixture",
		Now: func() time.Time {
			// No prior connection exists. The registry timestamp is requested
			// only after the selected connection has durably committed.
			cancel()
			return time.UnixMilli(123456789)
		},
	})

	result, err := profiles.Import(ctx, ProfileImport{Directory: source})
	if err != nil || !result.OK || result.Connected {
		t.Fatal("an acknowledged configuration commit was reported as failed or connected", err)
	}
	if binding, err := ReadBinding(data); err != nil || binding.Host != "selected.invalid" {
		t.Fatal("registry cancellation discarded the committed connection", err)
	}
	if discovery := profiles.Discover(); discovery.Current == nil || discovery.RegistryError == nil {
		t.Fatal("registry failure did not retain a bounded warning beside the usable connection")
	}
	if _, err := os.Stat(registry); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled registration created a partial registry", err)
	}
}

func TestProfileImportAndAutomaticSelectionPreserveInvalidStorage(t *testing.T) {
	root := t.TempDir()
	source := profileFixture(t, "selected.invalid")
	data := filepath.Join(root, "target")
	if err := os.MkdirAll(filepath.Join(data, "vm.json"), 0700); err != nil {
		t.Fatal(err)
	}
	profiles := profileManager(t, ProfileOptions{DataDir: data, ProjectRoot: root, Owner: "fixture"})
	if _, err := profiles.Import(t.Context(), ProfileImport{Directory: source}); !errors.Is(err, ErrBinding) {
		t.Fatal("a directory at the connection filename was silently replaced", err)
	}
	if info, err := os.Stat(filepath.Join(data, "vm.json")); err != nil || !info.IsDir() {
		t.Fatal("the original invalid storage was not retained", err)
	}

	blocked := filepath.Join(root, "regular-file")
	if err := os.WriteFile(blocked, []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	profiles = profileManager(t, ProfileOptions{
		DataDir: filepath.Join(blocked, "data"), ProjectRoot: root,
		Owner: "fixture", CandidateDirs: []string{source},
	})
	if result, err := profiles.AutoImport(t.Context()); !errors.Is(err, ErrBinding) || result.Current != nil || len(result.Candidates) != 1 {
		t.Fatal("automatic selection concealed a failed write or lost the selectable profile", err)
	}
	if raw, err := os.ReadFile(blocked); err != nil || string(raw) != "preserved" {
		t.Fatal("failed automatic selection changed the blocking file", err)
	}
}

func TestProfileConfigurationAndStorageFailuresAreBounded(t *testing.T) {
	root := t.TempDir()
	for _, options := range []ProfileOptions{
		{DataDir: "relative", ProjectRoot: root, Owner: "fixture"},
		{DataDir: root, ProjectRoot: "relative", Owner: "fixture"},
		{DataDir: root, ProjectRoot: root},
		{DataDir: root, ProjectRoot: root, Owner: "fixture", RegistryFile: "relative"},
	} {
		if _, err := NewProfiles(options); !errors.Is(err, ErrBinding) {
			t.Fatal("invalid profile manager options were accepted", err)
		}
	}
	blocked := filepath.Join(root, "regular-file")
	_ = os.WriteFile(blocked, []byte("preserved"), 0600)
	source := profileFixture(t, "selected.invalid")
	profiles := profileManager(t, ProfileOptions{DataDir: filepath.Join(blocked, "data"), ProjectRoot: root, Owner: "fixture"})
	if _, err := profiles.Import(t.Context(), ProfileImport{Directory: source}); !errors.Is(err, ErrBinding) {
		t.Fatal("a non-directory target was replaced", err)
	}
	if registry := DefaultProfileRegistry(root, map[string]string{"LOCALAPPDATA": root}); !filepath.IsAbs(registry) || !strings.HasSuffix(registry, filepath.Join("dant", "vm-profiles.json")) {
		t.Fatal("default registry escaped its captured user root")
	}
	if runtime.GOOS == "windows" && DefaultProfileRegistry(root, nil) != filepath.Join(root, "AppData", "Local", "dant", "vm-profiles.json") {
		t.Fatal("Windows fallback registry changed")
	}
}
