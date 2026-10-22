package backups

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func firefoxWorkerProfileFixture(t *testing.T, workspace string) string {
	t.Helper()
	profile := filepath.Join(workspace, "isolated-firefox-profile")
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"prefs.js", "times.json", "compatibility.ini"} {
		if err := os.WriteFile(filepath.Join(profile, name), []byte("isolated marker"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(profile, "places.sqlite"), []byte(sqliteMagic+"opaque fixture bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("isolated-fixture:+1234", filepath.Join(profile, "lock")); err != nil {
		t.Fatal(err)
	}
	return profile
}

func TestLinuxWorkerCaptureExcludesBrowserProfilesWithoutOpeningTheirContents(t *testing.T) {
	for _, scenario := range []string{"valid profile", "missing marker", "fake database", "invalid target", "changed lock"} {
		t.Run(scenario, func(t *testing.T) {
			options := workerSnapshotFixture(t)
			profile := firefoxWorkerProfileFixture(t, options.WorkspaceRoot)
			lock := filepath.Join(profile, "lock")
			switch scenario {
			case "missing marker":
				if err := os.Remove(filepath.Join(profile, "times.json")); err != nil {
					t.Fatal(err)
				}
			case "fake database":
				if err := os.WriteFile(filepath.Join(profile, "places.sqlite"), []byte("not a SQLite-format marker"), 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid target":
				if err := os.Remove(lock); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("untrusted-target", lock); err != nil {
					t.Fatal(err)
				}
			case "changed lock":
				checks := 0
				options.ValidateCurrent = func(context.Context) error {
					checks++
					if checks == 2 {
						if err := os.Remove(lock); err != nil {
							return err
						}
						return os.Symlink("isolated-fixture:+5678", lock)
					}
					return nil
				}
			}
			backup, err := CreateWorkerBackup(t.Context(), options)
			if err != nil || backup == nil {
				t.Fatal("unrelated browser lock affected agent backup", err)
			}
			defer backup.Close()
			for _, entry := range backup.Archive.Entries {
				if strings.Contains(entry.Path, "isolated-firefox-profile/") {
					t.Fatal("browser contents were serialized into an agent backup")
				}
			}
			if _, err := os.Lstat(lock); err != nil {
				t.Fatal("read-only capture removed the browser's lock", err)
			}
		})
	}
}

func TestLinuxAgentBackupDoesNotProbeUnreadableExcludedWorkspaceDirectories(t *testing.T) {
	options := workerSnapshotFixture(t)
	for _, name := range []string{"browser-profile", ".venv", "repository"} {
		directory := filepath.Join(options.WorkspaceRoot, name)
		if err := os.Mkdir(directory, 0000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(directory, 0700) })
	}
	footprint, err := PreflightWorkerBackup(t.Context(), WorkerPreflightOptions{DataDir: options.DataDir, WorkspaceRoot: options.WorkspaceRoot, SourceID: options.SourceID})
	if err != nil || footprint.Files != 1 {
		t.Fatal("excluded directory permissions affected capacity estimation", err)
	}
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal("excluded directory permissions affected agent capture", err)
	}
	defer backup.Close()
	for _, entry := range backup.Archive.Entries {
		if entry.Domain == "workspace" {
			t.Fatal("unrelated workspace directory was packaged")
		}
	}
}
