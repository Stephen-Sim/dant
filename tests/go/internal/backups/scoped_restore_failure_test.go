package backups

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func runScopedRestoreStorage(t *testing.T, options RestoreOptions, encoded []byte, storage restoreStorage) (RestoreReceipt, error) {
	t.Helper()
	var receipt RestoreReceipt
	err := withRestoreLock(t.Context(), options, func(locations restorePaths) error {
		var err error
		receipt, err = restoreWorkerWithStorage(t.Context(), options, locations, bytes.NewReader(encoded), storage)
		return err
	})
	return receipt, err
}

func TestScopedRestoreReconcilesEveryDurableWriteBeforeAndAfterAcknowledgment(t *testing.T) {
	for failure := 1; failure <= 4; failure++ {
		for _, afterWrite := range []bool{false, true} {
			t.Run(fmt.Sprintf("write-%d/after-%t", failure, afterWrite), func(t *testing.T) {
				options := scopedLiveFixture(t)
				_, encoded := scopedArchiveFixture(t)
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
				if receipt, err := runScopedRestoreStorage(t, options, encoded, storage); !errors.Is(err, io.ErrClosedPipe) || receipt.Restored || writes != failure {
					t.Fatal("uncertain durable write was retried or reported successful", err)
				}
				committed := failure == 4 && afterWrite
				if found, err := InspectWorkerRestore(options); err != nil || found.Restored != committed {
					t.Fatal("durable receipt did not reconcile actual committed state", err)
				}
				if proof, err := InspectWorkerRestoreRejection(options); err != nil || proof.Rejected == committed {
					t.Fatal("rejection proof contradicted actual transaction", err)
				}
				if committed {
					if found, err := RestoreWorkerBackup(t.Context(), options, errorReader{}); err != nil || !found.Restored {
						t.Fatal("committed uncertain result replayed input", err)
					}
				} else {
					assertOriginalRestoreRoots(t, options)
				}
			})
		}
	}
}

func TestScopedRestoreFlushAndOfflineFailuresNeverInstallLibraries(t *testing.T) {
	for failure := 1; failure <= 6; failure++ {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			options := scopedLiveFixture(t)
			_, encoded := scopedArchiveFixture(t)
			storage := restoreTransactionStorage()
			flushes := 0
			storage.flushTree = func(ctx context.Context, name string) error {
				flushes++
				if flushes == failure {
					return io.ErrClosedPipe
				}
				return flushRestoreTree(ctx, name)
			}
			checks := 0
			options.AssertOffline = func(context.Context) error {
				checks++
				if failure == 6 && checks == 2 {
					return ErrBusy
				}
				return nil
			}
			if receipt, err := runScopedRestoreStorage(t, options, encoded, storage); err == nil || receipt.Restored {
				t.Fatal("failed flush/service guard installed scoped data")
			}
			assertOriginalRestoreRoots(t, options)
			if proof, err := InspectWorkerRestoreRejection(options); err != nil || !proof.Rejected {
				t.Fatal("failed preparation lacks rollback proof", err)
			}
		})
	}
}

func TestScopedRestoreCompletedButUnacknowledgedMovesAreNotReplayed(t *testing.T) {
	for failure := 1; failure <= 12; failure++ {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			options := scopedLiveFixture(t)
			_, encoded := scopedArchiveFixture(t)
			calls := 0
			options.Rename = func(ctx context.Context, from, to string) error {
				calls++
				if err := files.RenameManaged(ctx, from, to); err != nil {
					return err
				}
				if calls == failure {
					return io.ErrClosedPipe
				}
				return nil
			}
			if receipt, err := RestoreWorkerBackup(t.Context(), options, bytes.NewReader(encoded)); err == nil || receipt.Restored {
				t.Fatal("unacknowledged move was confirmed successful")
			}
			assertOriginalRestoreRoots(t, options)
			if proof, err := InspectWorkerRestoreRejection(options); err != nil || !proof.Rejected {
				t.Fatal("exact directory identities could not reconcile the completed move", err)
			}
		})
	}
}

func TestScopedRecoveryRetainsJournalUntilRollbackAndCleanupAreConfirmed(t *testing.T) {
	for _, mode := range []string{"cancelled", "move-live", "move-original", "foreign-previous", "foreign-file", "committed-staging", "missing-original"} {
		t.Run(mode, func(t *testing.T) {
			options, locations, journal := scopedRecoveryFixture(t)
			component := journal.Components[0]
			paths := scopedPaths(locations, component, options.RestoreID)
			if err := os.Rename(paths.live, paths.previous); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(paths.incoming, paths.live); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "cancelled":
				cancel()
			case "move-live", "move-original":
				options.Rename = func(ctx context.Context, from, to string) error {
					if mode == "move-live" && from == paths.live || mode == "move-original" && from == paths.previous {
						return io.ErrClosedPipe
					}
					return files.RenameManaged(ctx, from, to)
				}
			case "foreign-previous", "missing-original":
				if err := os.Rename(paths.previous, paths.previous+"-retained"); err != nil {
					t.Fatal(err)
				}
				if mode == "foreign-previous" {
					if err := os.Mkdir(paths.previous, 0700); err != nil {
						t.Fatal(err)
					}
				}
			case "foreign-file":
				if err := os.WriteFile(paths.failed, []byte("foreign evidence"), 0600); err != nil {
					t.Fatal(err)
				}
			case "committed-staging":
				journal.Phase = contracts.WorkerRestorePhaseCommitted
				if err := writeRestoreJSON(ctx, locations.journal, journal); err != nil {
					t.Fatal(err)
				}
			}
			if err := recoverPending(ctx, options, journal); err == nil {
				t.Fatal("unconfirmed rollback/cleanup was accepted")
			}
			if _, err := os.Lstat(locations.journal); err != nil {
				t.Fatal("unconfirmed recovery removed durable ownership")
			}
			if mode == "cancelled" || mode == "move-live" || mode == "move-original" {
				options.Rename = nil
				if _, err := RecoverWorkerRestore(t.Context(), options); err != nil {
					t.Fatal("later independent recovery could not finish", err)
				}
				assertOriginalRestoreRoots(t, options)
			}
		})
	}
}

func TestScopedJournalRejectsInvalidComponentOwnershipAndPathCoverage(t *testing.T) {
	for _, mode := range []string{"incoming", "original", "same-identity", "parent-identity", "parents-count", "domain", "traversal", "data-path", "data-original", "first-component", "duplicate-identity", "overlap", "workspace-depth", "workspace-owner", "agents-owner", "unknown-library", "non-conversation"} {
		t.Run(mode, func(t *testing.T) {
			_, locations, journal := scopedRecoveryFixture(t)
			component := &journal.Components[1]
			switch mode {
			case "incoming":
				component.Incoming.Ino = "unknown"
			case "original":
				component.Original = &directoryID{}
			case "same-identity":
				component.Original = &component.Incoming
			case "parent-identity":
				component.Parents[0] = directoryID{}
			case "parents-count":
				component.Parents = nil
			case "domain":
				component.Domain = "project"
			case "traversal":
				component.Path = "../browser"
			case "data-path":
				journal.Components[0].Path = "other"
			case "data-original":
				journal.Components[0].Original = nil
			case "first-component":
				journal.Components[0], journal.Components[1] = journal.Components[1], journal.Components[0]
			case "duplicate-identity":
				component.Incoming = journal.Components[len(journal.Components)-1].Incoming
			case "overlap":
				component.Path = scopedEmptyID + "/.agents/skills"
			case "workspace-depth":
				component.Path = scopedExistingID + "/.agents/skills/nested"
				component.Parents = append(component.Parents, component.Parents[0])
			case "workspace-owner":
				component.Path = scopedExistingID
				component.Parents = component.Parents[:1]
			case "agents-owner":
				component.Path = scopedExistingID + "/.agents"
				component.Parents = component.Parents[:2]
			case "unknown-library":
				component.Path = scopedExistingID + "/.agents/browser"
			case "non-conversation":
				component.Path = "browser/.agents/skills"
			}
			if err := writeRestoreJSON(t.Context(), locations.journal, journal); err != nil {
				t.Fatal(err)
			}
			if _, err := readJournal(locations.journal); !errors.Is(err, ErrRestoreFailed) {
				t.Fatal("invalid component paths or ownership accepted", err)
			}
		})
	}
}

type scopedSwapOnEOF struct {
	*bytes.Reader
	once func()
}

func (input *scopedSwapOnEOF) Read(buffer []byte) (int, error) {
	count, err := input.Reader.Read(buffer)
	if err == io.EOF && input.once != nil {
		operation := input.once
		input.once = nil
		operation()
	}
	return count, err
}

func TestScopedRestoreDoesNotAdoptRootsReplacedDuringArchiveValidation(t *testing.T) {
	for _, domain := range []string{"data", "workspace"} {
		t.Run(domain, func(t *testing.T) {
			options := scopedLiveFixture(t)
			_, encoded := scopedArchiveFixture(t)
			root := options.DataDir
			if domain == "workspace" {
				root = options.WorkspaceRoot
			}
			input := &scopedSwapOnEOF{Reader: bytes.NewReader(encoded), once: func() {
				if err := os.Rename(root, root+"-retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "foreign"), []byte("retained replacement"), 0600); err != nil {
					t.Fatal(err)
				}
			}}
			if receipt, err := RestoreWorkerBackup(t.Context(), options, input); err == nil || receipt.Restored {
				t.Fatal("root replacement was adopted")
			}
			if raw, err := os.ReadFile(filepath.Join(root, "foreign")); err != nil || string(raw) != "retained replacement" {
				t.Fatal("foreign replacement was overwritten or deleted", err)
			}
			if _, err := os.Lstat(filepath.Join(root+"-retained", "original")); err != nil {
				t.Fatal("original data was not retained", err)
			}
		})
	}
}

func TestScopedRestoreStagesPrivateWorkspaceOnItsDestinationFilesystem(t *testing.T) {
	options := scopedLiveFixture(t)
	_, encoded := scopedArchiveFixture(t)
	workspaceParent := t.TempDir()
	workspace := filepath.Join(workspaceParent, "workspace")
	if err := os.Rename(options.WorkspaceRoot, workspace); err != nil {
		t.Fatal(err)
	}
	options.WorkspaceRoot = workspace
	dataParent := filepath.Dir(options.DataDir)
	options.Rename = func(ctx context.Context, from, to string) error {
		if !containsRoot(workspace, from) && containsRoot(workspace, to) {
			return syscall.EXDEV
		}
		return files.RenameManaged(ctx, from, to)
	}
	storage := restoreTransactionStorage()
	copies := 0
	storage.copyTree = func(ctx context.Context, source, target string) error {
		copies++
		if source == options.WorkspaceRoot || !containsRoot(dataParent, source) || !containsRoot(workspace, target) {
			t.Fatal("restore copied live workspace or staged on the data filesystem")
		}
		return copyRestoreTree(ctx, source, target)
	}
	if receipt, err := runScopedRestoreStorage(t, options, encoded, storage); err != nil || !receipt.Restored || copies != 1 {
		t.Fatal("independent data/workspace filesystems prevented scoped restore", err)
	}
	if raw, err := os.ReadFile(filepath.Join(workspace, scopedExistingID, "browser", "profile.sqlite")); err != nil || string(raw) != "browser data" {
		t.Fatal("private staging included or replaced live browser profile", err)
	}
}

func TestScopedRestorePrivateCopyFailuresNeverTouchLiveRoots(t *testing.T) {
	for _, afterCopy := range []bool{false, true} {
		t.Run(fmt.Sprint(afterCopy), func(t *testing.T) {
			options := scopedLiveFixture(t)
			_, encoded := scopedArchiveFixture(t)
			storage := restoreTransactionStorage()
			storage.copyTree = func(ctx context.Context, source, target string) error {
				if afterCopy {
					if err := copyRestoreTree(ctx, source, target); err != nil {
						return err
					}
				}
				return io.ErrClosedPipe
			}
			if receipt, err := runScopedRestoreStorage(t, options, encoded, storage); !errors.Is(err, io.ErrClosedPipe) || receipt.Restored {
				t.Fatal("failed private copy was installed", err)
			}
			assertOriginalRestoreRoots(t, options)
			entries, err := os.ReadDir(options.WorkspaceRoot)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".dant-restore-workspace-") {
					t.Fatal("owned failed private workspace copy was not cleaned")
				}
			}
		})
	}
}

func TestScopedRecoveryPreservesForeignChildrenAddedToNewParents(t *testing.T) {
	options, locations, journal := scopedRecoveryFixture(t)
	component := journal.Components[len(journal.Components)-1]
	paths := scopedPaths(locations, component, options.RestoreID)
	foreign := filepath.Join(paths.incoming, "browser", "profile.sqlite")
	if err := os.MkdirAll(filepath.Dir(foreign), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(foreign, []byte("new foreign browser"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := RecoverWorkerRestore(t.Context(), options); err == nil {
		t.Fatal("minimal-parent ownership was expanded to a new browser subtree")
	}
	if raw, err := os.ReadFile(foreign); err != nil || string(raw) != "new foreign browser" {
		t.Fatal("foreign browser contents were removed during cleanup", err)
	}
	if _, err := os.Lstat(locations.journal); err != nil {
		t.Fatal("unconfirmed ownership journal removed")
	}
	assertOriginalRestoreRoots(t, options)
}
