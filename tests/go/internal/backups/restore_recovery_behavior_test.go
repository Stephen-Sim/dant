package backups

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func recoveryJournalFixture(t *testing.T, options RestoreOptions, phase contracts.WorkerRestorePhase) (restorePaths, restoreJournal) {
	t.Helper()
	locations, err := restoreLocations(options)
	if err != nil {
		t.Fatal(err)
	}
	data, err := ordinaryIdentity(options.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := ordinaryIdentity(options.WorkspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	journal := restoreJournal{RestoreID: options.RestoreID, Phase: phase, Data: data, Workspace: workspace}
	if err := writeRestoreJSON(t.Context(), locations.journal, journal); err != nil {
		t.Fatal(err)
	}
	return locations, journal
}

func TestWorkerRecoveryRollsBackEveryInterruptedRootSwapWithoutReadingArchive(t *testing.T) {
	for completedMoves := 0; completedMoves <= 4; completedMoves++ {
		t.Run(fmt.Sprintf("moves-%d", completedMoves), func(t *testing.T) {
			options := restoreFixture(t)
			locations, _ := recoveryJournalFixture(t, options, contracts.WorkerRestorePhaseInstalling)
			for _, root := range []string{locations.dataNew, locations.workspaceNew} {
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "candidate"), []byte("new"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			moves := [][2]string{{locations.data, locations.dataPrevious}, {locations.workspace, locations.workspacePrevious}, {locations.dataNew, locations.data}, {locations.workspaceNew, locations.workspace}}
			for _, move := range moves[:completedMoves] {
				if err := os.Rename(move[0], move[1]); err != nil {
					t.Fatal(err)
				}
			}
			receipt, err := RecoverWorkerRestore(t.Context(), options)
			if err != nil || receipt.Restored || receipt.RestoreID != options.RestoreID {
				t.Fatalf("interrupted restore did not recover exact original roots: %v", err)
			}
			for root, expected := range map[string]string{locations.data: "original data", locations.workspace: "original workspace"} {
				content, err := os.ReadFile(filepath.Join(root, "original"))
				if err != nil || string(content) != expected {
					t.Fatal("rollback lost original data")
				}
			}
			for _, name := range []string{locations.journal, locations.lock, locations.dataNew, locations.workspaceNew, locations.dataPrevious, locations.workspacePrevious, locations.dataFailed, locations.workspaceFailed} {
				if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("known rollback left executable or conflicting staging")
				}
			}
		})
	}
}

func TestWorkerRecoveryRejectsChangedIdentityAndPreservesEvidence(t *testing.T) {
	for _, mode := range []string{"journal-json", "journal-phase", "journal-identity", "foreign-previous", "foreign-live", "temporary-directory", "journal-hardlink", "kernel-hardlink", "lock-json", "lock-pid", "live-owner"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, journal := recoveryJournalFixture(t, options, contracts.WorkerRestorePhasePrepared)
			write := func(name string, raw []byte) {
				t.Helper()
				if err := os.WriteFile(name, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "journal-json":
				write(locations.journal, []byte(`{"phase":`))
			case "journal-phase":
				journal.Phase = contracts.WorkerRestorePhase("future")
				raw, _ := json.Marshal(journal)
				write(locations.journal, raw)
			case "journal-identity":
				journal.Data.Ino = "foreign"
				raw, _ := json.Marshal(journal)
				write(locations.journal, raw)
			case "foreign-previous":
				if err := os.Mkdir(locations.dataPrevious, 0700); err != nil {
					t.Fatal(err)
				}
			case "foreign-live":
				if err := os.Rename(locations.workspace, locations.workspace+"-evidence"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(locations.workspace, 0700); err != nil {
					t.Fatal(err)
				}
			case "temporary-directory":
				if err := os.Mkdir(locations.journal+".tmp", 0700); err != nil {
					t.Fatal(err)
				}
			case "journal-hardlink":
				if err := os.Link(locations.journal, filepath.Join(t.TempDir(), "journal-evidence")); err != nil {
					t.Fatal(err)
				}
			case "kernel-hardlink":
				write(locations.kernel, []byte{})
				if err := os.Link(locations.kernel, filepath.Join(t.TempDir(), "kernel-evidence")); err != nil {
					t.Fatal(err)
				}
			case "lock-json":
				write(locations.lock, []byte("malformed"))
			case "lock-pid":
				write(locations.lock, []byte(`{"pid":0}`))
			case "live-owner":
				write(locations.lock, []byte(fmt.Sprintf(`{"pid":%d}`, os.Getpid())))
			}
			_, err := RecoverWorkerRestore(t.Context(), options)
			if err == nil {
				t.Fatal("uncertain recovery changed live roots")
			}
			if mode == "live-owner" && !errors.Is(err, ErrBusy) {
				t.Fatal("live owner was not classified as busy")
			}
			if _, err := os.Lstat(locations.journal); err != nil {
				t.Fatal("failed recovery destroyed its durable evidence")
			}
			if raw, err := os.ReadFile(filepath.Join(options.DataDir, "original")); err != nil || string(raw) != "original data" {
				t.Fatal("failed recovery lost original data")
			}
		})
	}
}

func TestWorkerRecoveryCanDiscardStaleOwnerAndJournalTemporaryWithoutReplay(t *testing.T) {
	options := restoreFixture(t)
	locations, _ := recoveryJournalFixture(t, options, contracts.WorkerRestorePhasePrepared)
	if err := os.WriteFile(locations.lock, []byte(`{"pid":2147483647}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(locations.journal+".tmp", []byte("interrupted atomic save"), 0600); err != nil {
		t.Fatal(err)
	}
	receipt, err := RecoverWorkerRestore(t.Context(), options)
	if err != nil || receipt.Restored {
		t.Fatalf("stale named lock prevented independently owned rollback: %v", err)
	}
	for _, name := range []string{locations.journal, locations.journal + ".tmp", locations.lock} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("settled recovery retained a stale fence")
		}
	}
}
