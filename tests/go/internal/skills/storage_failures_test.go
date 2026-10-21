package skills

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var errSkillStorageFixture = errors.New("synthetic skill storage failure")

func TestSkillSaveStorageFailuresPreservePriorContentAndKnownCommitState(t *testing.T) {
	for _, phase := range []string{"manifest", "support", "marker", "support-directory", "backup", "activation", "rollback", "cleanup", "snapshot"} {
		t.Run(phase, func(t *testing.T) {
			library := makeLibrary(t)
			input := skillInput()
			if _, err := library.Save(t.Context(), input, true); err != nil {
				t.Fatal(err)
			}
			disk := library.storage
			library.storage.writeAtomic = func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
				base := filepath.Base(path)
				if phase == "manifest" && base == "SKILL.md" || phase == "marker" && base == markerName || phase == "support" && base == "file.weird" {
					return errSkillStorageFixture
				}
				if phase == "support-directory" && base == "SKILL.md" {
					if err := os.WriteFile(filepath.Join(filepath.Dir(path), "assets"), []byte("obstructed directory"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return disk.writeAtomic(ctx, path, data, mode)
			}
			var backup string
			library.storage.rename = func(ctx context.Context, source, target string) error {
				if strings.HasPrefix(filepath.Base(target), ".backup-") {
					backup = target
					if phase == "backup" {
						return errSkillStorageFixture
					}
				}
				if (phase == "activation" || phase == "rollback") && strings.HasPrefix(filepath.Base(source), ".staging-") {
					return errSkillStorageFixture
				}
				if phase == "rollback" && source == backup {
					return fs.ErrPermission
				}
				return disk.rename(ctx, source, target)
			}
			library.storage.removeStaging = func(root, target string) error {
				if phase == "cleanup" && strings.HasPrefix(filepath.Base(target), ".backup-") {
					return errSkillStorageFixture
				}
				return disk.removeStaging(root, target)
			}
			opened := 0
			library.storage.openRoot = func(path string, create bool) (skillRoot, error) {
				opened++
				if phase == "snapshot" && opened == 2 {
					return nil, errSkillStorageFixture
				}
				return disk.openRoot(path, create)
			}
			input.Description = "Updated description"
			if _, err := library.Save(t.Context(), input, true); err == nil {
				t.Fatal("failed persistence phase was reported as successful")
			}
			library.storage = disk
			if phase == "rollback" {
				if _, err := os.Stat(filepath.Join(backup, "SKILL.md")); err != nil {
					t.Fatal("unconfirmed rollback discarded the recoverable backup", err)
				}
				return
			}
			snapshot, err := library.ExportSnapshot(t.Context(), input.Name)
			want := "Test skill"
			if phase == "cleanup" || phase == "snapshot" {
				want = input.Description
			}
			if err != nil || snapshot.Description != want || snapshot.Files["references/test.txt"] != "original text" || len(snapshot.BinaryFiles) != 1 {
				t.Fatal("failed operation changed its known committed state", err)
			}
		})
	}
}

func TestSkillCancelledActivationRollsBackWithAnIndependentBoundedContext(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	if _, err := library.Save(t.Context(), input, true); err != nil {
		t.Fatal(err)
	}
	disk := library.storage
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	rolledBack := false
	library.storage.rename = func(operation context.Context, source, target string) error {
		if strings.HasPrefix(filepath.Base(source), ".staging-") {
			cancel()
			return context.Canceled
		}
		if strings.HasPrefix(filepath.Base(source), ".backup-") {
			if _, bounded := operation.Deadline(); !bounded || operation.Err() != nil {
				t.Fatal("rollback inherited the cancelled request or lost its deadline")
			}
			rolledBack = true
		}
		return disk.rename(operation, source, target)
	}
	input.Description = "New description"
	if _, err := library.Save(ctx, input, true); !errors.Is(err, context.Canceled) || !rolledBack {
		t.Fatal("cancelled activation lost its error or failed to restore existing data", err)
	}
	library.storage = disk
	snapshot, err := library.ExportSnapshot(t.Context(), input.Name)
	if err != nil || snapshot.Description != "Test skill" {
		t.Fatal("cancelled activation left replacement content", err)
	}
}

func TestSkillStorageLookupToggleRemovalAndUnmanagedDestinationFailures(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	if exists, err := library.Exists(t.Context(), input.Name); err != nil || exists {
		t.Fatal("missing skill was invented", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := library.Exists(ctx, input.Name); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled lookup ignored cancellation")
	}
	if _, err := library.Exists(t.Context(), "invalid!"); err == nil {
		t.Fatal("invalid lookup name accepted")
	}
	if _, err := library.Save(t.Context(), input, true); err != nil {
		t.Fatal(err)
	}
	if exists, err := library.Exists(t.Context(), input.Name); err != nil || !exists {
		t.Fatal("saved skill disappeared", err)
	}
	disk := library.storage
	library.storage.rename = func(context.Context, string, string) error { return errSkillStorageFixture }
	if _, err := library.SetEnabled(t.Context(), input.Name, false); !errors.Is(err, errSkillStorageFixture) {
		t.Fatal("failed toggle was accepted", err)
	}
	if err := library.Remove(t.Context(), input.Name); !errors.Is(err, errSkillStorageFixture) {
		t.Fatal("failed removal was accepted", err)
	}
	library.storage = disk
	if _, err := library.SetEnabled(t.Context(), "absent", false); err == nil {
		t.Fatal("missing skill was toggled")
	}
	if err := os.Remove(library.disabledRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(library.disabledRoot, []byte("obstructed directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := library.SetEnabled(t.Context(), input.Name, false); err == nil {
		t.Fatal("invalid disabled root accepted")
	}
	if err := os.Remove(library.disabledRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(library.disabledRoot, input.Name), 0o700); err != nil {
		t.Fatal(err)
	}
	input.Enabled = new(false)
	if _, err := library.Save(t.Context(), input, true); err == nil {
		t.Fatal("overwrite replaced an unmanaged disabled destination")
	}
	if err := removeStaging(library.enabledRoot, filepath.Join(library.workspace, "outside")); err == nil {
		t.Fatal("cleanup escaped its managed parent")
	}
	if err := removeStaging(library.enabledRoot, filepath.Join(library.enabledRoot, "visible")); err == nil {
		t.Fatal("cleanup accepted a non-staging name")
	}
	index, err := library.Context(t.Context())
	if err != nil || !strings.Contains(index, "test-skill") {
		t.Fatal("enabled skill omitted from the context index", err)
	}
	if err := library.Remove(t.Context(), "invalid!"); err == nil {
		t.Fatal("invalid removal name accepted")
	}
	if err := removeStaging(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), ".staging")); err == nil {
		t.Fatal("cleanup accepted a missing or mismatched parent")
	}
	rootFile := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(rootFile, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(rootFile, Options{}); err == nil {
		t.Fatal("library accepted a regular file as its workspace")
	}
	if err := removeStaging(rootFile, filepath.Join(rootFile, ".staging")); err == nil {
		t.Fatal("cleanup traversed a regular file as a parent")
	}
}
