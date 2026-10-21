package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPreflightScannerRejectsUnavailableCancelledAndUnownedEntries(t *testing.T) {
	for _, scenario := range []string{"cancelled directory", "missing directory", "directory is file", "cancelled child", "missing child", "invalid child path", "hardlinked child", "observation capacity"} {
		t.Run(scenario, func(t *testing.T) {
			options := preflightFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			scanner := footprintScanner{ctx: ctx, workspace: options.WorkspaceRoot, observed: workerCapture{ctx: ctx}}
			directory := options.WorkspaceRoot
			name, prefix := "original", ""
			switch scenario {
			case "cancelled directory", "cancelled child":
				cancel()
			case "missing directory":
				directory = filepath.Join(directory, "missing")
			case "directory is file":
				directory = filepath.Join(directory, "original")
			case "missing child":
				name = "missing"
			case "invalid child path":
				prefix = ".."
			case "hardlinked child":
				if err := os.Link(filepath.Join(directory, name), filepath.Join(t.TempDir(), "second-owner")); err != nil {
					t.Fatal(err)
				}
			case "observation capacity":
				scanner.observed.observed = make([]observedSource, MaxFiles*5+1)
			}
			var err error
			if scenario == "cancelled directory" || scenario == "missing directory" || scenario == "directory is file" {
				err = scanner.directory(directory, "workspace", "")
			} else {
				err = scanner.child(directory, "workspace", prefix, name)
			}
			if err == nil || scanner.footprint.Files != 0 || scanner.footprint.ContentBytes != 0 {
				t.Fatal("unavailable source produced a successful capacity observation", err)
			}
			if scenario == "cancelled directory" || scenario == "cancelled child" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal("scanner lost the caller's cancellation", err)
				}
			}
			if raw, err := os.ReadFile(filepath.Join(options.WorkspaceRoot, "original")); err != nil || string(raw) != "original workspace" {
				t.Fatal("rejected observation modified original content", err)
			}
		})
	}
}

func TestWorkerPreflightRejectsMissingRootAndTheSameDataAndWorkspaceRoot(t *testing.T) {
	for _, same := range []bool{false, true} {
		options := preflightFixture(t)
		if same {
			options.WorkspaceRoot = options.DataDir
		} else {
			options.DataDir = filepath.Join(options.DataDir, "missing")
		}
		if _, err := PreflightWorkerBackup(t.Context(), options); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid root ownership produced a capacity estimate", err)
		}
	}
}

func TestWorkerPreflightRejectsInvalidConfigurationWithoutObservingAFile(t *testing.T) {
	for _, scenario := range []string{"relative data", "relative workspace", "unknown source"} {
		options := preflightFixture(t)
		switch scenario {
		case "relative data":
			options.DataDir = "relative"
		case "relative workspace":
			options.WorkspaceRoot = "relative"
		case "unknown source":
			options.SourceID = "contains unsafe whitespace"
		}
		if _, err := PreflightWorkerBackup(t.Context(), options); !errors.Is(err, ErrInvalid) {
			t.Fatal("unvalidated configuration acquired a capacity observation", err)
		}
	}
}
