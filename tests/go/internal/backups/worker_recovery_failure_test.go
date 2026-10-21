package backups

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestWorkerRecoveryPreservesJournalAndOriginalRootsWhenRollbackCannotFinish(t *testing.T) {
	for _, mode := range []string{"cancelled-journal", "invalid-live", "move-live", "move-original", "cleanup-file", "changed-parent"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, journal := recoveryJournalFixture(t, options, contracts.WorkerRestorePhaseInstalling)
			if err := os.Rename(locations.data, locations.dataPrevious); err != nil {
				t.Fatal(err)
			}
			if mode == "invalid-live" {
				if err := os.WriteFile(locations.data, []byte("unrelated replacement"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Mkdir(locations.data, 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "cancelled-journal":
				cancel()
			case "move-live", "move-original":
				options.Rename = func(ctx context.Context, source, target string) error {
					if mode == "move-live" && source == locations.data || mode == "move-original" && source == locations.dataPrevious {
						return io.ErrClosedPipe
					}
					return files.RenameManaged(ctx, source, target)
				}
			case "cleanup-file":
				if err := os.WriteFile(locations.workspaceNew, []byte("unowned cleanup evidence"), 0600); err != nil {
					t.Fatal(err)
				}
			case "changed-parent":
				options.DataDir = filepath.Join(t.TempDir(), "missing-parent", "data")
			}
			if err := recoverPending(ctx, options, journal); err == nil {
				t.Fatal("unfinished rollback was reported settled")
			}
			if _, err := os.Lstat(locations.journal); err != nil {
				t.Fatal("failed rollback discarded durable recovery evidence", err)
			}
			original := locations.dataPrevious
			if mode == "cleanup-file" {
				original = locations.data
			}
			if raw, err := os.ReadFile(filepath.Join(original, "original")); err != nil || string(raw) != "original data" {
				t.Fatal("incomplete rollback lost the original data", err)
			}
			if mode == "move-live" || mode == "move-original" || mode == "cancelled-journal" {
				options.Rename = nil
				if result, err := RecoverWorkerRestore(t.Context(), options); err != nil || result.Restored {
					t.Fatal("independent recovery could not finish from retained evidence", err)
				}
				assertOriginalRestoreRoots(t, options)
			}
		})
	}
}

func TestWorkerRestoreInspectionStopsBeforeArchiveConsumptionOnInvalidEvidence(t *testing.T) {
	for _, mode := range []string{"temporary-directory", "invalid-journal", "receipt-pending", "rejection-old", "data-file", "workspace-file"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "temporary-directory":
				if err := os.Mkdir(locations.journal+".tmp", 0700); err != nil {
					t.Fatal(err)
				}
			case "invalid-journal":
				if err := os.WriteFile(locations.journal, []byte("invalid retained journal"), 0600); err != nil {
					t.Fatal(err)
				}
			case "receipt-pending":
				recoveryJournalFixture(t, options, contracts.WorkerRestorePhasePrepared)
				if err := os.WriteFile(filepath.Join(options.DataDir, WorkerRestoreReceiptFile), []byte(`{"restored":true,"restoreId":"`+options.RestoreID+`"}`), 0600); err != nil {
					t.Fatal(err)
				}
				if result, err := InspectWorkerRestore(options); !errors.Is(err, ErrRestoreFailed) || result.Restored {
					t.Fatal("pending journal was ignored by a matching-looking receipt", err)
				}
				return
			case "rejection-old":
				if err := writeRestoreJSON(t.Context(), locations.rejection, RestoreRejection{Rejected: true, RestoreID: options.RestoreID}); err != nil {
					t.Fatal(err)
				}
			case "data-file", "workspace-file":
				root := options.DataDir
				if mode == "workspace-file" {
					root = options.WorkspaceRoot
				}
				if err := os.Rename(root, root+"-evidence"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(root, []byte("unrelated file"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			reader := &restoreReadCounter{}
			result, err := RestoreWorkerBackup(t.Context(), options, reader)
			if err == nil || result.Restored || mode != "rejection-old" && reader.reads != 0 {
				t.Fatalf("invalid retained evidence was ignored: reads=%d err=%v", reader.reads, err)
			}
			if mode == "rejection-old" {
				if reader.reads != 1 {
					t.Fatal("new explicit restore did not consume its archive exactly once")
				}
				if proof, err := InspectWorkerRestoreRejection(options); err != nil || !proof.Rejected {
					t.Fatal("invalid replacement archive did not settle as independently rejected", err)
				}
			}
		})
	}
}

type restoreReadCounter struct{ reads int }

func (value *restoreReadCounter) Read([]byte) (int, error) {
	value.reads++
	return 0, io.ErrUnexpectedEOF
}

func TestRestoreCleanupCannotCrossAReplacedOrMissingParent(t *testing.T) {
	options := restoreFixture(t)
	locations, err := restoreLocations(options)
	if err != nil {
		t.Fatal(err)
	}
	locations.dataNew = filepath.Join(t.TempDir(), "missing", "owned-name")
	if err := removeRestoreDirectory(locations, locations.dataNew); !errors.Is(err, ErrRestoreFailed) {
		t.Fatal("cleanup accepted an unavailable parent", err)
	}
	for index, phase := range []contracts.WorkerRestorePhase{contracts.WorkerRestorePhasePrepared, contracts.WorkerRestorePhaseInstalling} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			options := restoreFixture(t)
			locations, journal := recoveryJournalFixture(t, options, phase)
			if err := os.Remove(locations.journal); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(locations.journal, 0700); err != nil {
				t.Fatal(err)
			}
			if err := recoverPending(t.Context(), options, journal); !errors.Is(err, ErrRestoreFailed) {
				t.Fatal("recovery continued without durable rollback ownership", err)
			}
			assertOriginalRestoreRoots(t, options)
		})
	}
}
