package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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

func TestLinuxWorkerCaptureSkipsOnlyAnAuthenticatedFirefoxRuntimeLock(t *testing.T) {
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
			if scenario == "valid profile" {
				if err != nil || backup == nil {
					t.Fatal("authenticated Firefox runtime lock was captured as user content", err)
				}
				defer backup.Close()
				for _, entry := range backup.Archive.Entries {
					if filepath.Base(entry.Path) == "lock" {
						t.Fatal("runtime lock was serialized into a portable backup")
					}
				}
			} else {
				if err == nil || backup != nil {
					t.Fatal("unproven or changed runtime link produced a backup")
				}
				assertSnapshotStagesEmpty(t, options.TemporaryRoot)
			}
			if _, err := os.Lstat(lock); err != nil {
				t.Fatal("read-only capture removed the browser's lock", err)
			}
		})
	}
}

func TestLinuxFirefoxLockProofStopsWhenItsObservationBudgetCannotRetainIdentity(t *testing.T) {
	capture, workspace := captureBoundaryFixture(t)
	profile := firefoxWorkerProfileFixture(t, workspace)
	capture.observed = make([]observedSource, MaxFiles*5+1)
	if err := capture.directory(workspace, "workspace", ""); !errors.Is(err, ErrSizeLimit) {
		t.Fatal("capture exceeded retained source evidence capacity", err)
	}
	info, err := os.Lstat(filepath.Join(profile, "lock"))
	if err != nil {
		t.Fatal(err)
	}
	if known, err := capture.firefoxLock(profile, filepath.Join(profile, "lock"), info); !errors.Is(err, ErrSizeLimit) || known {
		t.Fatal("Firefox link was skipped without space for its captured identity", err)
	}
	scanner := footprintScanner{ctx: t.Context(), workspace: workspace, observed: capture}
	if err := scanner.child(profile, "workspace", "isolated-firefox-profile", "lock"); !errors.Is(err, ErrSizeLimit) {
		t.Fatal("preflight omitted a browser lock after its identity could not be retained", err)
	}
}
