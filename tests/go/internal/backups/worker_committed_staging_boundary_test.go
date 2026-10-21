package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestCommittedRestoreCannotClaimUnexpectedStagingOrFailedRoots(t *testing.T) {
	for _, domain := range []string{"new-data", "new-workspace", "failed-data", "failed-workspace"} {
		t.Run(domain, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			foreign := map[string]string{
				"new-data": locations.dataNew, "new-workspace": locations.workspaceNew,
				"failed-data": locations.dataFailed, "failed-workspace": locations.workspaceFailed,
			}[domain]
			marker := filepath.Join(foreign, "retained.txt")
			storage := restoreTransactionStorage()
			storage.writeJSON = func(ctx context.Context, name string, value any) error {
				if err := writeRestoreJSON(ctx, name, value); err != nil {
					return err
				}
				journal, ok := value.(restoreJournal)
				if !ok || journal.Phase != contracts.WorkerRestorePhaseCommitted {
					return nil
				}
				if err := os.Mkdir(foreign, 0700); err != nil {
					return err
				}
				return os.WriteFile(marker, []byte("belongs to an independent operation"), 0600)
			}
			if receipt, err := runRestoreTransaction(t, t.Context(), options, storage); !errors.Is(err, ErrRestoreFailed) || receipt.Restored {
				t.Fatal("committed cleanup adopted an unexpected staging directory", err)
			}
			if data, err := os.ReadFile(marker); err != nil || string(data) != "belongs to an independent operation" {
				t.Fatal("cleanup removed unowned staging evidence", err)
			}
			for _, previous := range []string{locations.dataPrevious, locations.workspacePrevious} {
				if _, err := os.Stat(filepath.Join(previous, "original")); err != nil {
					t.Fatal("cleanup partially removed previous roots before rejecting unexpected evidence", err)
				}
			}
			if journal, err := readJournal(locations.journal); err != nil || journal == nil || journal.Phase != contracts.WorkerRestorePhaseCommitted {
				t.Fatal("unconfirmed cleanup lost the independently committed journal", err)
			}
			input := &restoreReadCounter{}
			if _, err := RestoreWorkerBackup(t.Context(), options, input); !errors.Is(err, ErrRestoreFailed) || input.reads != 0 {
				t.Fatal("unconfirmed cleanup replayed archive consumption", err)
			}
		})
	}
}
