package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func skillFixtureRoot(t testing.TB, workspace string) string {
	t.Helper()
	root := filepath.Join(workspace, "49954ce5-c8c5-4f6e-a7d8-531530d09479", ".agents", "skills")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

func memoryFixtureRoot(t testing.TB, data string) string {
	t.Helper()
	root := filepath.Join(data, "memory", "dant")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

func agentFixtureArchive(content []byte) []byte {
	raw := fixtureArchive(content)
	raw = bytes.Replace(raw, []byte(ArchiveMagic+"\n"), []byte(AgentDataArchiveMagic+"\n"), 1)
	return bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":2,"scope":"agent-data"`), 1)
}

func TestAgentDataCaptureAndPreflightExcludeWorkspaceRuntimeTrees(t *testing.T) {
	options := workerSnapshotFixture(t)
	skills := skillFixtureRoot(t, options.WorkspaceRoot)
	disabled := filepath.Join(options.WorkspaceRoot, "49954ce5-c8c5-4f6e-a7d8-531530d09479", ".dant-disabled-skills")
	if err := os.Mkdir(disabled, 0700); err != nil {
		t.Fatal(err)
	}
	content := []byte{0x89, 'P', 'N', 'G', 0, 255, '\n'}
	for _, name := range []string{
		filepath.Join(skills, "asset.png"),
		filepath.Join(skills, "build"),
		filepath.Join(memoryFixtureRoot(t, options.DataDir), "identity.md"),
		filepath.Join(options.DataDir, "telegram.json"),
		filepath.Join(options.DataDir, "notifications.json"),
		filepath.Join(options.DataDir, "voice-key.dpapi"),
	} {
		if err := os.WriteFile(name, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	cacheSkill := filepath.Join(skills, "cache")
	if err := os.Mkdir(cacheSkill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheSkill, "SKILL.md"), content, 0600); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{
		filepath.Join(options.WorkspaceRoot, "49954ce5-c8c5-4f6e-a7d8-531530d09479", "browser-profile"),
		filepath.Join(options.WorkspaceRoot, "49954ce5-c8c5-4f6e-a7d8-531530d09479", ".venv"),
		filepath.Join(options.WorkspaceRoot, "49954ce5-c8c5-4f6e-a7d8-531530d09479", "project", "node_modules"),
		filepath.Join(options.WorkspaceRoot, "49954ce5-c8c5-4f6e-a7d8-531530d09479", "output"),
		filepath.Join(options.DataDir, "browser-profile"),
		filepath.Join(options.DataDir, "memory", "unrelated"),
		filepath.Join(skills, "python-skill", ".venv"),
		filepath.Join(skills, "node-skill", "node_modules"),
		filepath.Join(skills, "python-skill", "__pycache__"),
		filepath.Join(skills, "node-skill", "dist"),
	} {
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		file, err := os.Create(filepath.Join(root, "must-not-open.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if err := sparsePreflightFixture(file, MaxFileBytes+1); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	footprint, err := PreflightWorkerBackup(t.Context(), WorkerPreflightOptions{DataDir: options.DataDir, WorkspaceRoot: options.WorkspaceRoot, SourceID: options.SourceID})
	if err != nil || footprint.Files != 8 {
		t.Fatal("preflight included an unrelated runtime tree", footprint, err)
	}
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	if backup.Archive.Manifest.SchemaVersion != AgentDataSchemaVersion || backup.Archive.Manifest.Scope != AgentDataScope || backup.Archive.Manifest.Files != footprint.Files || backup.Archive.Manifest.Bytes != footprint.ContentBytes {
		t.Fatal("capture and capacity estimate disagree on the selected scope")
	}
	var output bytes.Buffer
	if err := backup.WriteTo(t.Context(), &output); err != nil || !bytes.HasPrefix(output.Bytes(), []byte(AgentDataArchiveMagic+"\n")) {
		t.Fatal("new capture omitted its incompatible archive marker", err)
	}
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(output.Bytes()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	disabledSeen := false
	for _, entry := range archive.Entries {
		if strings.Contains(entry.Path, "must-not-open") {
			t.Fatal("runtime contents were packaged")
		}
		if entry.Domain == "workspace" && entry.Path == "49954ce5-c8c5-4f6e-a7d8-531530d09479/.dant-disabled-skills" && entry.Directory {
			disabledSeen = true
		}
	}
	if !disabledSeen {
		t.Fatal("empty managed skill root was omitted")
	}
	actual, err := os.ReadFile(filepath.Join(archive.Directory, "workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479", ".agents", "skills", "asset.png"))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("binary skill bytes changed", err)
	}
	retained := []ArchiveEntry{}
	for _, entry := range archive.Entries {
		if entry.Domain == "workspace" && entry.Path == "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills" {
			continue
		}
		retained = append(retained, entry)
	}
	archive.Entries = retained
	if err := WriteArchive(t.Context(), io.Discard, archive); !errors.Is(err, ErrInvalid) {
		t.Fatal("writer accepted skill contents without their explicit restore root", err)
	}
	lines := bytes.Split(output.Bytes(), []byte{'\n'})
	filtered := [][]byte{}
	for _, line := range lines {
		if bytes.Contains(line, []byte(`"path":"49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills"`)) {
			continue
		}
		filtered = append(filtered, line)
	}
	if _, err := ValidateArchive(t.Context(), bytes.NewReader(bytes.Join(filtered, []byte{'\n'})), t.TempDir()); !errors.Is(err, ErrInvalid) {
		t.Fatal("decoder accepted skill contents without their explicit restore root", err)
	}
}

func TestAgentDataArchiveRejectsScopeAndVersionAmbiguity(t *testing.T) {
	valid := agentFixtureArchive([]byte("{}"))
	for _, input := range [][]byte{
		bytes.Replace(valid, []byte(`"scope":"agent-data"`), []byte(`"scope":null`), 1),
		bytes.Replace(valid, []byte(`"scope":"agent-data",`), nil, 1),
		bytes.Replace(valid, []byte(`"scope":"agent-data"`), []byte(`"scope":"workspace"`), 1),
		bytes.Replace(valid, []byte(`"scope":"agent-data"`), []byte(`"scope":"agent-data","unknown":true`), 1),
		bytes.Replace(valid, []byte(AgentDataArchiveMagic), []byte(ArchiveMagic), 1),
		bytes.Replace(valid, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":1`), 1),
		bytes.Replace(fixtureArchive([]byte("{}")), []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"scope":""`), 1),
		bytes.Replace(fixtureArchive([]byte("{}")), []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"scope":null`), 1),
		bytes.Replace(fixtureArchive([]byte("{}")), []byte(ArchiveMagic), []byte(AgentDataArchiveMagic), 1),
	} {
		if _, err := ValidateArchive(t.Context(), bytes.NewReader(input), t.TempDir()); !errors.Is(err, ErrInvalid) {
			t.Fatal("ambiguous archive scope was accepted", err)
		}
	}
	for _, raw := range [][]byte{valid, fixtureArchive([]byte("{}"))} {
		archive, err := ValidateArchive(t.Context(), bytes.NewReader(raw), t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := WriteArchive(t.Context(), &output, archive); err != nil || !bytes.Equal(raw, output.Bytes()) {
			t.Fatal("archive round trip changed the legacy or scoped format", err)
		}
	}
}

func TestAgentDataEntryScopeRequiresOwnedRootsAndDirectoryAncestors(t *testing.T) {
	for _, fixture := range []struct {
		domain, path string
		directory    bool
		allowed      bool
	}{
		{"data", "state.json", false, true},
		{"data", "state.json", true, false},
		{"data", "notifications.json", false, true},
		{"data", "attachments", true, true},
		{"data", "attachments", false, false},
		{"data", "attachments/file.bin", false, true},
		{"data", "memory", true, true},
		{"data", "memory", false, false},
		{"data", "memory/dant", true, true},
		{"data", "memory/dant/identity.md", false, true},
		{"data", "memory/other/file", false, false},
		{"data", "browser/profile", true, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479", true, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents", true, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills", true, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/asset.png", false, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.dant-disabled-skills", true, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.dant-disabled-skills/skill/SKILL.md", false, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/node_modules", false, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/node_modules", true, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/cache/SKILL.md", false, true},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/skill/node_modules", true, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/skill/.venv/file", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/skill/build/asset", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/instructions.md", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/project/file", false, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/browser-profile", true, false},
		{"workspace", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/../escape", false, false},
		{"other", "state.json", false, false},
	} {
		if agentArchiveEntryAllowed(fixture.domain, fixture.path, fixture.directory) != fixture.allowed {
			t.Fatal("incorrect logical backup selection", fixture)
		}
	}
	for _, path := range []string{"49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/skill/asset.png", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.dant-disabled-skills/skill"} {
		root, found := agentWorkspaceRoot(path)
		if !found || !strings.HasPrefix(path, root) {
			t.Fatal("managed root identity was lost")
		}
	}
	for _, path := range []string{"49954ce5-c8c5-4f6e-a7d8-531530d09479", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents", "49954ce5-c8c5-4f6e-a7d8-531530d09479/output", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/../escape"} {
		if _, found := agentWorkspaceRoot(path); found {
			t.Fatal("unowned path acquired a managed restore root")
		}
	}
	for _, path := range []string{"project/file", "49954ce5-c8c5-4f6e-a7d8-531530d09479/.agents/skills/skill/node_modules/file"} {
		raw := bytes.Replace(agentFixtureArchive([]byte("{}")), []byte(`"domain":"data","path":"state.json"`), []byte(`"domain":"workspace","path":"`+path+`"`), 1)
		if _, err := ValidateArchive(t.Context(), bytes.NewReader(raw), t.TempDir()); !errors.Is(err, ErrInvalid) {
			t.Fatal("out-of-scope entry was extracted", err)
		}
	}
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(agentFixtureArchive([]byte("{}"))), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	archive.Entries[0].Path = "browser/profile"
	if err := WriteArchive(context.Background(), io.Discard, archive); !errors.Is(err, ErrInvalid) {
		t.Fatal("writer accepted an out-of-scope entry", err)
	}
}

func TestAgentBackupConversationDirectoryMatchesPersistedIdentityContract(t *testing.T) {
	for _, name := range []string{testRestoreID, strings.ToUpper(testRestoreID), "49954ce5-c8c5-1f6e-a7d8-531530d09479", "49954ce5-c8c5-5f6e-a7d8-531530d09479"} {
		if !agentConversationDirectory(name) || !agentScopeCandidate("workspace", name+"/.agents/skills") {
			t.Fatal("supported persisted conversation directory was excluded")
		}
	}
	for _, name := range []string{"project", ".venv", "browser-profile", "49954ce5c8c54f6ea7d8531530d09479", "49954ce5-c8c5-7f6e-a7d8-531530d09479", "49954ce5-c8c5-4f6e-07d8-531530d09479", "{49954ce5-c8c5-4f6e-a7d8-531530d09479}"} {
		if agentConversationDirectory(name) || agentScopeCandidate("workspace", name+"/.agents/skills") {
			t.Fatal("unrelated directory acquired conversation ownership")
		}
	}
}

func TestAgentDataBackupRejectsOwnedRootFilesWithoutChangingThem(t *testing.T) {
	for _, location := range []string{"conversation", "enabled-parent", "enabled-root", "disabled-root", "memory", "attachments"} {
		t.Run(location, func(t *testing.T) {
			options := workerSnapshotFixture(t)
			name := filepath.Join(options.WorkspaceRoot, testRestoreID)
			switch location {
			case "enabled-parent":
				name = filepath.Join(name, ".agents")
			case "enabled-root":
				name = filepath.Join(name, ".agents", "skills")
			case "disabled-root":
				name = filepath.Join(name, ".dant-disabled-skills")
			case "memory", "attachments":
				name = filepath.Join(options.DataDir, location)
			}
			if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
				t.Fatal(err)
			}
			original := []byte("preserve malformed root evidence")
			if err := os.WriteFile(name, original, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := PreflightWorkerBackup(t.Context(), WorkerPreflightOptions{DataDir: options.DataDir, WorkspaceRoot: options.WorkspaceRoot, SourceID: options.SourceID}); !errors.Is(err, ErrInvalid) {
				t.Fatal("malformed owned root produced a footprint", err)
			}
			if backup, err := CreateWorkerBackup(t.Context(), options); !errors.Is(err, ErrInvalid) || backup != nil {
				t.Fatal("malformed owned root produced an archive", err)
			}
			if actual, err := os.ReadFile(name); err != nil || !bytes.Equal(actual, original) {
				t.Fatal("rejected snapshot changed the malformed root", err)
			}
			assertSnapshotStagesEmpty(t, options.TemporaryRoot)
		})
	}
}
