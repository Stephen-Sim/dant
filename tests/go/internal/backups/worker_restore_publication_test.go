package backups

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func restoreTransactionStorage() restoreStorage {
	return restoreStorage{writeJSON: writeRestoreJSON, copyTree: copyRestoreTree, flushTree: flushRestoreTree}
}

func runRestoreTransaction(t *testing.T, ctx context.Context, options RestoreOptions, storage restoreStorage) (RestoreReceipt, error) {
	t.Helper()
	var receipt RestoreReceipt
	err := withRestoreLock(ctx, options, func(locations restorePaths) error {
		var err error
		receipt, err = restoreWorkerWithStorage(ctx, options, locations, bytes.NewReader(fixtureArchive([]byte(restoreFixtureState))), storage)
		return err
	})
	return receipt, err
}

func assertOriginalRestoreRoots(t *testing.T, options RestoreOptions) {
	t.Helper()
	for root, want := range map[string]string{options.DataDir: "original data", options.WorkspaceRoot: "original workspace"} {
		if raw, err := os.ReadFile(filepath.Join(root, "original")); err != nil || string(raw) != want {
			t.Fatal("restore failure did not retain both original roots", err)
		}
	}
}

func TestRestorePublicationReconcilesEachDurableWriteWithoutReplayingUnknownInput(t *testing.T) {
	for failure := 1; failure <= 4; failure++ {
		for _, afterWrite := range []bool{false, true} {
			t.Run(fmt.Sprintf("write-%d/after-%t", failure, afterWrite), func(t *testing.T) {
				options := restoreFixture(t)
				storage := restoreTransactionStorage()
				writes := 0
				storage.writeJSON = func(ctx context.Context, name string, value any) error {
					writes++
					if writes != failure || afterWrite {
						if err := writeRestoreJSON(ctx, name, value); err != nil {
							return err
						}
					}
					if writes == failure {
						return io.ErrClosedPipe
					}
					return nil
				}
				receipt, err := runRestoreTransaction(t, t.Context(), options, storage)
				if !errors.Is(err, io.ErrClosedPipe) || receipt.Restored || writes != failure {
					t.Fatalf("publication failure was retried or reported confirmed: writes=%d error=%v", writes, err)
				}
				committed := failure == 4 && afterWrite
				found, err := InspectWorkerRestore(options)
				if err != nil || found.Restored != committed || found.RestoreID != options.RestoreID {
					t.Fatal("independent durable receipt did not reconcile the actual commit", err)
				}
				proof, err := InspectWorkerRestoreRejection(options)
				if err != nil || proof.Rejected == committed {
					t.Fatal("rollback proof contradicted independently observed live roots", err)
				}
				if committed {
					again, err := RestoreWorkerBackup(t.Context(), options, errorReader{})
					if err != nil || !again.Restored || again.RestoreID != options.RestoreID {
						t.Fatal("committed uncertain publication read or replayed the archive", err)
					}
				} else {
					assertOriginalRestoreRoots(t, options)
					again, err := RecoverWorkerRestore(t.Context(), options)
					if err != nil || again.Restored {
						t.Fatal("settled rejection restarted the restore", err)
					}
				}
				locations, err := restoreLocations(options)
				if err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{locations.journal, locations.lock, locations.dataNew, locations.workspaceNew, locations.dataPrevious, locations.workspacePrevious, locations.dataFailed, locations.workspaceFailed} {
					if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("reconciled publication retained executable staging or stale ownership", err)
					}
				}
			})
		}
	}
}

func TestRestorePreparationFailuresAndCancellationRollBackThroughIndependentStorage(t *testing.T) {
	for _, mode := range []string{"copy-before", "copy-after", "flush-data", "flush-workspace", "cancel-after-flush", "offline-after-flush", "changed-live-root"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			storage := restoreTransactionStorage()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if mode == "copy-before" || mode == "copy-after" {
				storage.copyTree = func(ctx context.Context, source, target string) error {
					if mode == "copy-after" {
						if err := copyRestoreTree(ctx, source, target); err != nil {
							return err
						}
					}
					return io.ErrUnexpectedEOF
				}
			}
			flushes := 0
			storage.flushTree = func(ctx context.Context, name string) error {
				flushes++
				if err := flushRestoreTree(ctx, name); err != nil {
					return err
				}
				if mode == "flush-data" && flushes == 1 || mode == "flush-workspace" && flushes == 2 {
					return io.ErrClosedPipe
				}
				if flushes == 2 {
					switch mode {
					case "cancel-after-flush":
						cancel()
						return ctx.Err()
					case "changed-live-root":
						if err := os.Rename(options.DataDir, options.DataDir+"-retained"); err != nil {
							return err
						}
						return os.Mkdir(options.DataDir, 0700)
					}
				}
				return nil
			}
			// The consumer receives an options value. Change the service proof at its
			// existing callback rather than replacing that captured value later.
			checks := 0
			options.AssertOffline = func(check context.Context) error {
				checks++
				if err := check.Err(); err != nil {
					return err
				}
				if mode == "offline-after-flush" && checks == 2 {
					return ErrBusy
				}
				return nil
			}
			if receipt, err := runRestoreTransaction(t, ctx, options, storage); err == nil || receipt.Restored {
				t.Fatal("failed preparation became a confirmed restore")
			}
			if mode == "changed-live-root" {
				if raw, err := os.ReadFile(filepath.Join(options.DataDir+"-retained", "original")); err != nil || string(raw) != "original data" {
					t.Fatal("identity rejection destroyed independently retained data", err)
				}
				if _, err := RecoverWorkerRestore(t.Context(), options); !errors.Is(err, ErrRestoreFailed) {
					t.Fatal("unproven replacement root was adopted during recovery", err)
				}
			} else {
				assertOriginalRestoreRoots(t, options)
				proof, err := InspectWorkerRestoreRejection(options)
				if err != nil || !proof.Rejected {
					t.Fatal("bounded uncancelled rollback did not retain a rejection proof", err)
				}
			}
		})
	}
}

func TestRestoreRenameUnknownOutcomeUsesDurableIdentityInsteadOfRepeatingTheMove(t *testing.T) {
	for failure := 1; failure <= 5; failure++ {
		t.Run(fmt.Sprintf("move-%d", failure), func(t *testing.T) {
			options := restoreFixture(t)
			calls := 0
			options.Rename = func(ctx context.Context, source, target string) error {
				calls++
				if err := files.RenameManaged(ctx, source, target); err != nil {
					return err
				}
				if calls == failure {
					return io.ErrClosedPipe
				}
				return nil
			}
			if result, err := RestoreWorkerBackup(t.Context(), options, bytes.NewReader(fixtureArchive([]byte(restoreFixtureState)))); !errors.Is(err, ErrRestoreFailed) || result.Restored {
				t.Fatal("unknown move was reported as a confirmed restore", err)
			}
			assertOriginalRestoreRoots(t, options)
			if proof, err := InspectWorkerRestoreRejection(options); err != nil || !proof.Rejected {
				t.Fatal("completed-but-unacknowledged move was not reconciled from exact root identities", err)
			}
		})
	}
}
