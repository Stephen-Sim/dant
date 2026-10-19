package backups

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

type restoreJournal struct {
	RestoreID string                       `json:"restoreId"`
	Phase     contracts.WorkerRestorePhase `json:"phase"`
	Data      directoryID                  `json:"data"`
	Workspace directoryID                  `json:"workspace"`
}

type RestoreReceipt struct {
	Restored  bool   `json:"restored"`
	RestoreID string `json:"restoreId"`
}

type RestoreRejection struct {
	Rejected  bool   `json:"rejected"`
	RestoreID string `json:"restoreId"`
}

type LoadedRestore struct {
	Restored  bool    `json:"restored"`
	RestoreID *string `json:"restoreId"`
}

type rejectionProof struct {
	RestoreRejection
	Data      directoryID `json:"data"`
	Workspace directoryID `json:"workspace"`
}

func ordinaryIdentity(name string) (directoryID, error) {
	if _, err := files.OrdinaryDirectory(name, false); err != nil {
		return directoryID{}, ErrRestoreFailed
	}

	return directoryIdentity(name)
}

func readJournal(name string) (*restoreJournal, error) {
	var journal restoreJournal
	if err := readRestoreJSON(name, &journal); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, ErrRestoreFailed
	}

	if !restoreID.MatchString(journal.RestoreID) || !journal.Phase.Valid() || !journal.Data.valid() || !journal.Workspace.valid() {
		return nil, ErrRestoreFailed
	}

	return &journal, nil
}

func discardJournalTemporary(name string) error {
	name += ".tmp"
	if _, err := files.ReadRegular(name, restoreJournalMaxBytes); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return ErrRestoreFailed
	}

	if err := os.Remove(name); err != nil {
		return ErrRestoreFailed
	}

	return syncDirectory(filepath.Dir(name))
}

func clearJournal(name string) error {
	if _, err := files.ReadRegular(name, restoreJournalMaxBytes); err != nil {
		return ErrRestoreFailed
	}

	if err := os.Remove(name); err != nil {
		return ErrRestoreFailed
	}

	return syncDirectory(filepath.Dir(name))
}

func recoverPending(ctx context.Context, options RestoreOptions, journal restoreJournal) error {
	options.RestoreID = journal.RestoreID
	locations, err := restoreLocations(options)
	if err != nil {
		return err
	}

	if journal.Phase != contracts.WorkerRestorePhaseCommitted {
		journal.Phase = contracts.WorkerRestorePhaseRollingBack
		if err := writeRestoreJSON(ctx, locations.journal, journal); err != nil {
			return err
		}
		for _, root := range []struct {
			live, previous, failed string
			wanted                 directoryID
		}{{locations.workspace, locations.workspacePrevious, locations.workspaceFailed, journal.Workspace}, {locations.data, locations.dataPrevious, locations.dataFailed, journal.Data}} {
			if _, err := os.Lstat(root.previous); err == nil {
				identity, err := ordinaryIdentity(root.previous)
				if err != nil || identity != root.wanted {
					return ErrRestoreFailed
				}
				if _, err := os.Lstat(root.live); err == nil {
					if _, err := ordinaryIdentity(root.live); err != nil {
						return ErrRestoreFailed
					}
					if err := restoreRename(ctx, options, root.live, root.failed); err != nil {
						return ErrRestoreFailed
					}
				} else if !errors.Is(err, os.ErrNotExist) {
					return ErrRestoreFailed
				}
				if err := restoreRename(ctx, options, root.previous, root.live); err != nil {
					return ErrRestoreFailed
				}
			} else if errors.Is(err, os.ErrNotExist) {
				identity, err := ordinaryIdentity(root.live)
				if err != nil || identity != root.wanted {
					return ErrRestoreFailed
				}
			} else {
				return ErrRestoreFailed
			}
		}
	}
	for _, name := range []string{locations.dataNew, locations.workspaceNew, locations.dataPrevious, locations.workspacePrevious, locations.dataFailed, locations.workspaceFailed} {
		if err := removeRestoreDirectory(locations, name); err != nil {
			return err
		}
	}

	return clearJournal(locations.journal)
}

func inspectRestore(options RestoreOptions, locations restorePaths) (RestoreReceipt, error) {
	receipt := RestoreReceipt{RestoreID: options.RestoreID}
	pending, err := readJournal(locations.journal)
	if err != nil || (pending != nil && pending.Phase != contracts.WorkerRestorePhaseCommitted) {
		return receipt, ErrRestoreFailed
	}
	var stored RestoreReceipt
	if err := readRestoreJSON(filepath.Join(locations.data, WorkerRestoreReceiptFile), &stored); errors.Is(err, os.ErrNotExist) {
		return receipt, nil
	} else if err != nil {
		return receipt, ErrRestoreFailed
	}
	receipt.Restored = stored.Restored && stored.RestoreID == options.RestoreID
	return receipt, nil
}

func InspectWorkerRestore(options RestoreOptions) (RestoreReceipt, error) {
	locations, err := restoreLocations(options)
	if err != nil {
		return RestoreReceipt{}, err
	}

	return inspectRestore(options, locations)
}

func InspectWorkerRestoreRejection(options RestoreOptions) (RestoreRejection, error) {
	result := RestoreRejection{RestoreID: options.RestoreID}
	locations, err := restoreLocations(options)
	if err != nil {
		return result, err
	}
	journal, err := readJournal(locations.journal)
	if err != nil {
		return result, err
	}

	if journal != nil {
		return result, nil
	}
	var proof rejectionProof
	if err := readRestoreJSON(locations.rejection, &proof); errors.Is(err, os.ErrNotExist) {
		return result, nil
	} else if err != nil {
		return result, ErrRestoreFailed
	}
	data, err := ordinaryIdentity(locations.data)
	if err != nil {
		return result, err
	}
	workspace, err := ordinaryIdentity(locations.workspace)
	if err != nil {
		return result, err
	}
	receipt, err := inspectRestore(options, locations)
	if err != nil {
		return result, err
	}
	result.Rejected = proof.Rejected && proof.RestoreID == options.RestoreID && proof.Data.valid() && proof.Workspace.valid() && data == proof.Data && workspace == proof.Workspace && !receipt.Restored
	return result, nil
}

func LoadedWorkerRestoreInfo(dataDir, workspaceRoot string) (LoadedRestore, error) {
	var stored RestoreReceipt
	if err := readRestoreJSON(filepath.Join(dataDir, WorkerRestoreReceiptFile), &stored); errors.Is(err, os.ErrNotExist) {
		return LoadedRestore{}, nil
	} else if err != nil || !stored.Restored || !restoreID.MatchString(stored.RestoreID) {
		return LoadedRestore{}, ErrRestoreFailed
	}
	receipt, err := InspectWorkerRestore(RestoreOptions{DataDir: dataDir, WorkspaceRoot: workspaceRoot, RestoreID: stored.RestoreID})
	return LoadedRestore{Restored: receipt.Restored, RestoreID: &stored.RestoreID}, err
}

func assertOffline(ctx context.Context, options RestoreOptions) error {
	if options.AssertOffline == nil {
		return ErrBusy
	}

	return options.AssertOffline(ctx)
}

func RecoverWorkerRestore(ctx context.Context, options RestoreOptions) (RestoreReceipt, error) {
	if err := assertOffline(ctx, options); err != nil {
		return RestoreReceipt{}, err
	}
	err := withRestoreLock(ctx, options, func(locations restorePaths) error {
		if err := discardJournalTemporary(locations.journal); err != nil {
			return err
		}
		journal, err := readJournal(locations.journal)
		if err != nil {
			return err
		}
		if journal != nil {
			return recoverPending(ctx, options, *journal)
		}
		return nil
	})
	if err != nil {
		return RestoreReceipt{}, err
	}

	return InspectWorkerRestore(options)
}

// RestoreWorkerBackup validates private staging before moving either live root.
// The durable journal records ownership before the first named staging path;
// recovery rolls back unfinished installs without reading or replaying input.
func RestoreWorkerBackup(ctx context.Context, options RestoreOptions, input io.Reader) (RestoreReceipt, error) {
	if err := assertOffline(ctx, options); err != nil {
		return RestoreReceipt{}, err
	}
	locations, err := restoreLocations(options)
	if err != nil {
		return RestoreReceipt{}, err
	}
	for _, root := range []string{locations.data, locations.workspace} {
		if _, err := files.OrdinaryDirectory(root, true); err != nil {
			return RestoreReceipt{}, ErrRestoreFailed
		}
	}
	var receipt RestoreReceipt
	err = withRestoreLock(ctx, options, func(locations restorePaths) error {
		var inner error
		receipt, inner = restoreWorkerLocked(ctx, options, locations, input)
		return inner
	})
	return receipt, err
}

func restoreWorkerLocked(ctx context.Context, options RestoreOptions, locations restorePaths, input io.Reader) (receipt RestoreReceipt, result error) {
	receipt = RestoreReceipt{RestoreID: options.RestoreID}
	if err := discardJournalTemporary(locations.journal); err != nil {
		return receipt, err
	}
	pending, err := readJournal(locations.journal)
	if err != nil {
		return receipt, err
	}

	if pending != nil {
		if err := recoverPending(ctx, options, *pending); err != nil {
			return receipt, err
		}
	}

	if found, err := inspectRestore(options, locations); err != nil {
		return receipt, err
	} else if found.Restored {
		return found, nil
	}

	if _, err := files.ReadRegular(locations.rejection, restoreJournalMaxBytes); err == nil {
		if err := clearJournal(locations.rejection); err != nil {
			return receipt, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return receipt, ErrRestoreFailed
	}
	for _, name := range []string{locations.dataNew, locations.workspaceNew, locations.dataPrevious, locations.workspacePrevious, locations.dataFailed, locations.workspaceFailed} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			return receipt, ErrRestoreFailed
		}
	}
	data, err := ordinaryIdentity(locations.data)
	if err != nil {
		return receipt, err
	}
	workspace, err := ordinaryIdentity(locations.workspace)
	if err != nil {
		return receipt, err
	}
	original := restoreJournal{RestoreID: options.RestoreID, Phase: contracts.WorkerRestorePhasePrepared, Data: data, Workspace: workspace}
	defer func() {
		if result == nil {
			return
		}
		// Rollback is a separate, bounded recovery of an already-owned local
		// transaction; cancellation must not leave half of the roots installed.
		recovery, stop := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer stop()
		if discardJournalTemporary(locations.journal) != nil {
			return
		}
		journal, err := readJournal(locations.journal)
		if err != nil {
			return
		}
		if journal != nil {
			if recoverPending(recovery, options, *journal) != nil {
				return
			}
		}
		found, err := inspectRestore(options, locations)
		if err != nil || found.Restored {
			return
		}
		currentData, e1 := ordinaryIdentity(locations.data)
		currentWorkspace, e2 := ordinaryIdentity(locations.workspace)
		if e1 == nil && e2 == nil && currentData == data && currentWorkspace == workspace && assertOffline(recovery, options) == nil {
			_ = writeRestoreJSON(recovery, locations.rejection, rejectionProof{RestoreRejection: RestoreRejection{Rejected: true, RestoreID: options.RestoreID}, Data: data, Workspace: workspace})
		}
	}()
	decoding, err := os.MkdirTemp(locations.dataParent, ".dant-restore-validate-")
	if err != nil {
		return receipt, ErrRestoreFailed
	}
	_ = os.Chmod(decoding, 0700)
	identity, err := os.Lstat(decoding)
	if err != nil {
		return receipt, ErrRestoreFailed
	}
	defer func() {
		if current, err := os.Lstat(decoding); err == nil && current.IsDir() && os.SameFile(identity, current) && filepath.Dir(decoding) == locations.dataParent {
			_ = os.RemoveAll(decoding)
		}
	}()
	archive, err := ValidateArchive(ctx, input, decoding)
	if err != nil {
		return receipt, ErrRestoreFailed
	}

	if err := PrepareRestoredWorkerState(ctx, decoding); err != nil {
		return receipt, ErrRestoreFailed
	}

	if err := assertOffline(ctx, options); err != nil {
		return receipt, err
	}
	for _, root := range []string{"data", "workspace"} {
		if _, err := files.OrdinaryDirectory(filepath.Join(decoding, root), true); err != nil {
			return receipt, ErrRestoreFailed
		}
	}

	if err := writeRestoreJSON(ctx, filepath.Join(decoding, "data", WorkerRestoreReceiptFile), struct {
		RestoreReceipt
		SourceID  string `json:"sourceId"`
		CreatedAt int64  `json:"createdAt"`
	}{RestoreReceipt{Restored: true, RestoreID: options.RestoreID}, archive.Manifest.SourceID, time.Now().UnixMilli()}); err != nil {
		return receipt, err
	}

	if err := writeRestoreJSON(ctx, locations.journal, original); err != nil {
		return receipt, err
	}

	if err := restoreRename(ctx, options, filepath.Join(decoding, "data"), locations.dataNew); err != nil {
		return receipt, ErrRestoreFailed
	}

	if err := copyRestoreTree(ctx, filepath.Join(decoding, "workspace"), locations.workspaceNew); err != nil {
		return receipt, ErrRestoreFailed
	}

	if err := flushRestoreTree(ctx, locations.dataNew); err != nil {
		return receipt, err
	}

	if err := flushRestoreTree(ctx, locations.workspaceNew); err != nil {
		return receipt, err
	}

	if err := assertOffline(ctx, options); err != nil {
		return receipt, err
	}
	currentData, e1 := ordinaryIdentity(locations.data)
	currentWorkspace, e2 := ordinaryIdentity(locations.workspace)
	if e1 != nil || e2 != nil || currentData != data || currentWorkspace != workspace {
		return receipt, ErrRestoreFailed
	}
	original.Phase = contracts.WorkerRestorePhaseInstalling
	if err := writeRestoreJSON(ctx, locations.journal, original); err != nil {
		return receipt, err
	}
	for _, move := range [][2]string{{locations.data, locations.dataPrevious}, {locations.workspace, locations.workspacePrevious}, {locations.dataNew, locations.data}, {locations.workspaceNew, locations.workspace}} {
		if err := restoreRename(ctx, options, move[0], move[1]); err != nil {
			return receipt, ErrRestoreFailed
		}
	}
	original.Phase = contracts.WorkerRestorePhaseCommitted
	if err := writeRestoreJSON(ctx, locations.journal, original); err != nil {
		return receipt, err
	}

	if err := recoverPending(ctx, options, original); err != nil {
		return receipt, err
	}
	receipt.Restored = true
	return receipt, nil
}

func copyRestoreTree(ctx context.Context, source, destination string) error {
	if _, err := files.OrdinaryDirectory(source, false); err != nil {
		return ErrRestoreFailed
	}

	if err := os.Mkdir(destination, 0700); err != nil {
		return ErrRestoreFailed
	}

	return filepath.WalkDir(source, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrRestoreFailed
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return ErrRestoreFailed
		}
		if relative == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return ErrRestoreFailed
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.Mkdir(target, 0700)
		}
		info, err := os.Lstat(name)
		if err != nil || !info.Mode().IsRegular() || info.Size() > MaxFileBytes {
			return ErrRestoreFailed
		}
		input, err := os.Open(name)
		if err != nil {
			return err
		}
		defer input.Close()
		opened, err := input.Stat()
		if err != nil || !os.SameFile(info, opened) || !stageSingleLink(input) {
			return ErrRestoreFailed
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, err = copyBounded(ctx, output, input, info.Size())
		if err == nil {
			err = output.Sync()
		}
		closeErr := output.Close()
		after, statErr := input.Stat()
		if err != nil || closeErr != nil || statErr != nil || !os.SameFile(info, after) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || !stageSingleLink(input) {
			return ErrRestoreFailed
		}
		return nil
	})
}

func flushRestoreTree(ctx context.Context, directory string) error {
	if _, err := files.OrdinaryDirectory(directory, false); err != nil {
		return ErrRestoreFailed
	}
	var directories []string
	err := filepath.WalkDir(directory, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrRestoreFailed
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return ErrRestoreFailed
		}
		if entry.IsDir() {
			directories = append(directories, name)
			return nil
		}
		before, err := os.Lstat(name)
		if err != nil || !before.Mode().IsRegular() {
			return ErrRestoreFailed
		}
		file, err := os.OpenFile(name, os.O_RDWR, 0)
		if err != nil {
			return ErrRestoreFailed
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil || !os.SameFile(before, opened) || !stageSingleLink(file) {
			return ErrRestoreFailed
		}
		return file.Sync()
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := syncDirectory(directories[index]); err != nil {
			return err
		}
	}

	return nil
}
