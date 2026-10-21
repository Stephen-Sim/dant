package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestCommittedRestoreCleanupPreservesAReplacedPreviousDirectory(t *testing.T) {
	for _, domain := range []string{"data", "workspace"} {
		t.Run(domain, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			previous := locations.dataPrevious
			if domain == "workspace" {
				previous = locations.workspacePrevious
			}
			retained := previous + "-retained-original"
			marker := filepath.Join(previous, "unrelated.txt")
			storage := restoreTransactionStorage()
			replacements := 0
			storage.writeJSON = func(ctx context.Context, name string, value any) error {
				if err := writeRestoreJSON(ctx, name, value); err != nil {
					return err
				}
				journal, ok := value.(restoreJournal)
				if !ok || journal.Phase != contracts.WorkerRestorePhaseCommitted {
					return nil
				}
				replacements++
				if err := os.Rename(previous, retained); err != nil {
					return err
				}
				if err := os.Mkdir(previous, 0700); err != nil {
					return err
				}
				return os.WriteFile(marker, []byte("replacement belongs to another operation"), 0600)
			}
			receipt, restoreErr := runRestoreTransaction(t, t.Context(), options, storage)
			if raw, err := os.ReadFile(marker); err != nil || string(raw) != "replacement belongs to another operation" {
				t.Fatal("committed restore cleanup removed a replacement directory it never captured", err)
			}
			if !errors.Is(restoreErr, ErrRestoreFailed) || receipt.Restored || replacements != 1 {
				t.Fatal("unconfirmed cleanup was reported complete or its commit was replayed", restoreErr)
			}
			if raw, err := os.ReadFile(filepath.Join(retained, "original")); err != nil || string(raw) != "original "+domain {
				t.Fatal("failed cleanup lost the retained original root", err)
			}
			found, err := InspectWorkerRestore(options)
			if err != nil || !found.Restored {
				t.Fatal("cleanup failure hid the independently committed restore receipt", err)
			}
			reader := &restoreReadCounter{}
			if _, err := RestoreWorkerBackup(t.Context(), options, reader); !errors.Is(err, ErrRestoreFailed) || reader.reads != 0 {
				t.Fatal("unconfirmed cleanup permitted another archive read", err)
			}

			foreign := previous + "-retained-replacement"
			if err := os.Rename(previous, foreign); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(retained, previous); err != nil {
				t.Fatal(err)
			}
			if recovered, err := RecoverWorkerRestore(t.Context(), options); err != nil || !recovered.Restored {
				t.Fatal("independent identity reconciliation could not finish committed cleanup", err)
			}
			if raw, err := os.ReadFile(filepath.Join(foreign, "unrelated.txt")); err != nil || string(raw) != "replacement belongs to another operation" {
				t.Fatal("reconciliation removed independently retained replacement data", err)
			}
		})
	}
}

func TestCommittedRestoreCleanupAcceptsMatchingAndAlreadyMissingPreviousIdentities(t *testing.T) {
	for _, missing := range []string{"none", "data", "workspace", "both"} {
		t.Run(missing, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			retained := map[string]string{}
			storage := restoreTransactionStorage()
			storage.writeJSON = func(ctx context.Context, name string, value any) error {
				if err := writeRestoreJSON(ctx, name, value); err != nil {
					return err
				}
				journal, ok := value.(restoreJournal)
				if !ok || journal.Phase != contracts.WorkerRestorePhaseCommitted {
					return nil
				}
				for domain, previous := range map[string]string{"data": locations.dataPrevious, "workspace": locations.workspacePrevious} {
					if missing == domain || missing == "both" {
						preserved := previous + "-already-retired"
						if err := os.Rename(previous, preserved); err != nil {
							return err
						}
						retained[domain] = preserved
					}
				}
				return nil
			}
			if receipt, err := runRestoreTransaction(t, t.Context(), options, storage); err != nil || !receipt.Restored {
				t.Fatal("matching or already missing cleanup identities prevented a confirmed restore", err)
			}
			if _, err := os.Lstat(locations.journal); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("confirmed cleanup retained its completed journal", err)
			}
			for domain, name := range retained {
				if raw, err := os.ReadFile(filepath.Join(name, "original")); err != nil || string(raw) != "original "+domain {
					t.Fatal("idempotent cleanup searched for and deleted an already retired directory", err)
				}
			}
			if receipt, err := RecoverWorkerRestore(t.Context(), options); err != nil || !receipt.Restored {
				t.Fatal("already completed cleanup was not idempotent", err)
			}
		})
	}
}
