package backups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const (
	scopedExistingID  = "49954ce5-c8c5-4f6e-a7d8-531530d09479"
	scopedNewID       = "59954ce5-c8c5-4f6e-a7d8-531530d09479"
	scopedParentID    = "69954ce5-c8c5-4f6e-a7d8-531530d09479"
	scopedEmptyID     = "79954ce5-c8c5-4f6e-a7d8-531530d09479"
	scopedUntouchedID = "89954ce5-c8c5-4f6e-a7d8-531530d09479"
)

func scopedArchiveFixture(t *testing.T) (ValidatedArchive, []byte) {
	t.Helper()
	directory := t.TempDir()
	content := map[string][]byte{
		"data/state.json":            []byte(restoreFixtureState),
		"data/attachments/image.bin": {0, 0xff, 4, 0, 0xfe},
		"workspace/" + scopedExistingID + "/.agents/skills/example/SKILL.md":  []byte("new skill"),
		"workspace/" + scopedExistingID + "/.agents/skills/example/image.png": {0x89, 'P', 'N', 'G', 0, 0xff},
		"workspace/" + scopedNewID + "/.dant-disabled-skills/hidden/SKILL.md": []byte("disabled skill"),
		"workspace/" + scopedParentID + "/.agents/skills/example/SKILL.md":    []byte("new parent"),
	}
	for name, raw := range content {
		target := filepath.Join(directory, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(directory, "workspace", scopedEmptyID, ".agents", "skills"), 0700); err != nil {
		t.Fatal(err)
	}
	archive := ValidatedArchive{Directory: directory, Manifest: Manifest{SchemaVersion: 2, Scope: AgentDataScope, CreatedAt: 1000, AppVersion: "0.4.7", SourceID: "scoped-fixture"}}
	for _, domain := range []string{"data", "workspace"} {
		err := filepath.WalkDir(filepath.Join(directory, domain), func(name string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(filepath.Join(directory, domain), name)
			if err != nil || relative == "." {
				return err
			}
			record := ArchiveEntry{Domain: domain, Path: filepath.ToSlash(relative), Directory: entry.IsDir()}
			if !entry.IsDir() {
				raw, err := os.ReadFile(name)
				if err != nil {
					return err
				}
				sum := sha256.Sum256(raw)
				record.Size = int64(len(raw))
				record.SHA256 = hex.EncodeToString(sum[:])
				archive.Manifest.Files++
				archive.Manifest.Bytes += record.Size
			}
			archive.Entries = append(archive.Entries, record)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var encoded bytes.Buffer
	if err := WriteArchive(t.Context(), &encoded, archive); err != nil {
		t.Fatal(err)
	}
	return archive, encoded.Bytes()
}

func scopedLiveFixture(t *testing.T) RestoreOptions {
	t.Helper()
	options := restoreFixture(t)
	for name, raw := range map[string]string{
		scopedExistingID + "/.agents/skills/old/SKILL.md":   "old library",
		scopedExistingID + "/.agents/other/value":           "agent sibling",
		scopedExistingID + "/.venv/bin/python":              "virtual environment",
		scopedExistingID + "/browser/profile.sqlite":        "browser data",
		scopedExistingID + "/project/.git/config":           "project data",
		scopedExistingID + "/output/delivered.txt":          "live output",
		scopedParentID + "/project/value":                   "parent project",
		scopedUntouchedID + "/.agents/skills/keep/SKILL.md": "absent library stays",
	} {
		target := filepath.Join(options.WorkspaceRoot, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return options
}

func TestScopedRestorePreservesWorkspaceAndReplacesOnlyIncludedLibraries(t *testing.T) {
	options := scopedLiveFixture(t)
	_, encoded := scopedArchiveFixture(t)
	identities := make(map[string]directoryID)
	for _, name := range []string{"", scopedExistingID, scopedExistingID + "/.agents", scopedExistingID + "/.venv", scopedExistingID + "/browser", scopedExistingID + "/project", scopedExistingID + "/output", scopedParentID, scopedUntouchedID + "/.agents/skills"} {
		identity, err := ordinaryIdentity(filepath.Join(options.WorkspaceRoot, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		identities[name] = identity
	}
	receipt, err := RestoreWorkerBackup(t.Context(), options, bytes.NewReader(encoded))
	if err != nil || !receipt.Restored {
		t.Fatalf("scoped restore failed: %v", err)
	}
	for name, wanted := range identities {
		actual, err := ordinaryIdentity(filepath.Join(options.WorkspaceRoot, filepath.FromSlash(name)))
		if err != nil || actual != wanted {
			t.Fatalf("excluded workspace parent replaced: %s", name)
		}
	}
	for name, wanted := range map[string]string{
		scopedExistingID + "/.agents/other/value":              "agent sibling",
		scopedExistingID + "/.venv/bin/python":                 "virtual environment",
		scopedExistingID + "/browser/profile.sqlite":           "browser data",
		scopedExistingID + "/project/.git/config":              "project data",
		scopedExistingID + "/output/delivered.txt":             "live output",
		scopedUntouchedID + "/.agents/skills/keep/SKILL.md":    "absent library stays",
		scopedExistingID + "/.agents/skills/example/SKILL.md":  "new skill",
		scopedNewID + "/.dant-disabled-skills/hidden/SKILL.md": "disabled skill",
		scopedParentID + "/.agents/skills/example/SKILL.md":    "new parent",
	} {
		raw, err := os.ReadFile(filepath.Join(options.WorkspaceRoot, filepath.FromSlash(name)))
		if err != nil || string(raw) != wanted {
			t.Fatalf("wrong preserved/restored content: %s", name)
		}
	}
	if _, err := os.Lstat(filepath.Join(options.WorkspaceRoot, scopedExistingID, ".agents", "skills", "old")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("included library retained an obsolete skill")
	}
	if _, err := ordinaryIdentity(filepath.Join(options.WorkspaceRoot, scopedEmptyID, ".agents", "skills")); err != nil {
		t.Fatal("explicit empty library was lost")
	}
	raw, err := os.ReadFile(filepath.Join(options.WorkspaceRoot, scopedExistingID, ".agents", "skills", "example", "image.png"))
	if err != nil || !bytes.Equal(raw, []byte{0x89, 'P', 'N', 'G', 0, 0xff}) {
		t.Fatal("skill binary bytes changed")
	}
	if repeated, err := RestoreWorkerBackup(t.Context(), options, errorReader{}); err != nil || !repeated.Restored {
		t.Fatal("committed scoped restore replayed archive input")
	}
}

func TestScopedRestoreRollsBackEveryMoveAndCancellation(t *testing.T) {
	for failure := 1; failure <= 12; failure++ {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			options := scopedLiveFixture(t)
			_, encoded := scopedArchiveFixture(t)
			calls := 0
			options.Rename = func(ctx context.Context, from, to string) error {
				calls++
				if calls == failure {
					return io.ErrUnexpectedEOF
				}
				return files.RenameManaged(ctx, from, to)
			}
			if _, err := RestoreWorkerBackup(t.Context(), options, bytes.NewReader(encoded)); err == nil {
				t.Fatal("injected move failure was ignored")
			}
			if raw, err := os.ReadFile(filepath.Join(options.DataDir, "original")); err != nil || string(raw) != "original data" {
				t.Fatal("data rollback lost original")
			}
			if raw, err := os.ReadFile(filepath.Join(options.WorkspaceRoot, scopedExistingID, ".agents", "skills", "old", "SKILL.md")); err != nil || string(raw) != "old library" {
				t.Fatal("library rollback lost original")
			}
			if _, err := os.Lstat(filepath.Join(options.WorkspaceRoot, scopedNewID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("rollback retained new parent")
			}
			proof, err := InspectWorkerRestoreRejection(options)
			if err != nil || !proof.Rejected {
				t.Fatalf("fully rolled back restore lacks rejection proof: %v", err)
			}
		})
	}
	t.Run("cancel", func(t *testing.T) {
		options := scopedLiveFixture(t)
		_, encoded := scopedArchiveFixture(t)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		options.Rename = func(call context.Context, from, to string) error {
			if strings.HasSuffix(to, "-data.previous") {
				cancel()
				return ctx.Err()
			}
			return files.RenameManaged(call, from, to)
		}
		if _, err := RestoreWorkerBackup(ctx, options, bytes.NewReader(encoded)); err == nil {
			t.Fatal("canceled restore succeeded")
		}
		if proof, err := InspectWorkerRestoreRejection(options); err != nil || !proof.Rejected {
			t.Fatal("cancellation prevented separately owned rollback")
		}
	})
}

func scopedRecoveryFixture(t *testing.T) (RestoreOptions, restorePaths, restoreJournal) {
	t.Helper()
	options := scopedLiveFixture(t)
	archive, _ := scopedArchiveFixture(t)
	locations, err := restoreLocations(options)
	if err != nil {
		t.Fatal(err)
	}
	components, err := scopedComponents(locations, archive, filepath.Join(archive.Directory, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	journal := restoreJournal{SchemaVersion: 2, Scope: AgentDataScope, RestoreID: options.RestoreID, Phase: contracts.WorkerRestorePhaseInstalling, Components: components}
	if err := writeRestoreJSON(t.Context(), locations.journal, journal); err != nil {
		t.Fatal(err)
	}
	for _, component := range components {
		source := filepath.Join(archive.Directory, component.Domain, filepath.FromSlash(component.Path))
		if err := os.Rename(source, scopedPaths(locations, component, options.RestoreID).incoming); err != nil {
			t.Fatal(err)
		}
	}
	return options, locations, journal
}

func TestScopedRestoreRecoversEveryCrashWithoutArchiveOrReplacingParents(t *testing.T) {
	for completed := 0; completed <= 7; completed++ {
		t.Run(fmt.Sprint(completed), func(t *testing.T) {
			options, locations, journal := scopedRecoveryFixture(t)
			var moves [][2]string
			for _, component := range journal.Components {
				paths := scopedPaths(locations, component, options.RestoreID)
				if component.Original != nil {
					moves = append(moves, [2]string{paths.live, paths.previous})
				}
				moves = append(moves, [2]string{paths.incoming, paths.live})
			}
			for _, move := range moves[:completed] {
				if err := os.Rename(move[0], move[1]); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := RecoverWorkerRestore(t.Context(), options); err != nil {
				t.Fatalf("crash recovery failed: %v", err)
			}
			if raw, err := os.ReadFile(filepath.Join(options.DataDir, "original")); err != nil || string(raw) != "original data" {
				t.Fatal("crash recovery lost data")
			}
			if _, err := os.Lstat(locations.journal); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("settled recovery left journal")
			}
		})
	}
}

func TestScopedRestoreRefusesForeignReplacementAndRetainsEvidence(t *testing.T) {
	for _, mode := range []string{"incoming", "live", "parent-identity", "journal-scope", "journal-schema", "journal-overlap", "journal-legacy", "journal-unknown"} {
		t.Run(mode, func(t *testing.T) {
			options, locations, journal := scopedRecoveryFixture(t)
			component := journal.Components[1]
			paths := scopedPaths(locations, component, options.RestoreID)
			switch mode {
			case "incoming", "live", "parent-identity":
				name := paths.incoming
				if mode == "live" {
					name = paths.live
				} else if mode == "parent-identity" {
					name = options.WorkspaceRoot
				}
				if err := os.Rename(name, name+"-retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(name, 0700); err != nil {
					t.Fatal(err)
				}
			case "journal-scope":
				journal.Scope = "future"
			case "journal-schema":
				journal.SchemaVersion = 3
			case "journal-overlap":
				journal.Components = append(journal.Components, journal.Components[1])
			case "journal-legacy":
				journal.Data = journal.Components[0].Incoming
			case "journal-unknown":
				raw, err := os.ReadFile(locations.journal)
				if err != nil {
					t.Fatal(err)
				}
				raw = bytes.Replace(raw, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":2,"unexpected":true`), 1)
				if err := os.WriteFile(locations.journal, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if strings.HasPrefix(mode, "journal-") && mode != "journal-unknown" {
				if err := writeRestoreJSON(t.Context(), locations.journal, journal); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := RecoverWorkerRestore(t.Context(), options); err == nil {
				t.Fatal("foreign recovery was allowed")
			}
			if raw, err := os.ReadFile(filepath.Join(options.DataDir, "original")); err != nil || string(raw) != "original data" {
				t.Fatal("recovery mutated data before validating every component")
			}
			if _, err := os.Lstat(locations.journal); err != nil {
				t.Fatal("unconfirmed transaction evidence was removed")
			}
		})
	}
}
