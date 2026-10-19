package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func prepareWorker(ctx context.Context, startup config.Startup) error {
	if err := workerRuntime.VerifyVMHost(ctx, runtime.GOOS, os.Geteuid(), nil); err != nil {
		return err
	}
	return prepareDataOffline(ctx, startup, func(ctx context.Context) error {
		return backups.AssertWorkerOffline(ctx, startup.Home, startup.DataDir)
	})
}

// Preparation is offline and never connects a model or enables schedules. An
// existing installation requires a complete verified recovery archive first.
func prepareData(ctx context.Context, startup config.Startup) error {
	return prepareDataOffline(ctx, startup, func(ctx context.Context) error { return ctx.Err() })
}

func prepareDataOffline(ctx context.Context, startup config.Startup, offline func(context.Context) error) error {
	if err := offline(ctx); err != nil {
		return err
	}

	ticket, err := beginPreparation(ctx, startup, buildinfo.Version, buildinfo.Source)
	if err != nil {
		return err
	}

	owner, err := ownership.Acquire(ctx, startup.DataDir)
	if err != nil {
		return err
	}
	defer owner.Close()

	_, stateErr := os.Lstat(filepath.Join(startup.DataDir, "state.json"))
	if stateErr != nil && !os.IsNotExist(stateErr) {
		return stateErr
	}
	if stateErr == nil && startup.Backup == "" {
		return backups.ErrInvalid
	}

	backupHash := ""
	if startup.Backup != "" {
		backupHash, err = authenticatePreparationBackup(ctx, startup.Backup, stateErr == nil)
		if err != nil {
			return err
		}
	}

	if err := offline(ctx); err != nil {
		return err
	}
	if err := ticket.current(ctx); err != nil {
		return err
	}

	persistence, err := store.OpenContext(ctx, startup.DataDir, store.Options{})
	if err != nil {
		return err
	}
	defer persistence.Close()
	durable, err := memory.OpenStore(ctx, startup.DataDir, memory.StoreOptions{})
	if err != nil {
		return err
	}
	defer durable.Close()
	if err := durable.MigrateLegacy(ctx, persistence); err != nil {
		return err
	}

	state := persistence.Snapshot()
	database, err := schedules.OpenDatabase(ctx, startup.DataDir, state.Schedules, state.DeletedScheduleRequestIDs)
	if err != nil {
		return err
	}
	if err := database.Close(); err != nil {
		return err
	}
	if err := durable.Close(); err != nil {
		return err
	}
	persistence.Close()

	if err := offline(ctx); err != nil {
		return err
	}
	return ticket.finish(ctx, backupHash)
}

func validatePreparationBackup(ctx context.Context, name string, requireState bool) error {
	_, err := authenticatePreparationBackup(ctx, name, requireState)
	return err
}

func authenticatePreparationBackup(ctx context.Context, name string, requireState bool) (string, error) {
	root, err := files.OpenManagedRoot(filepath.Dir(name), false)
	if err != nil {
		return "", err
	}
	defer root.Close()

	staging, err := os.MkdirTemp("", "dant-prepare-validation-")
	if err != nil {
		return "", err
	}
	before, err := os.Lstat(staging)
	if err != nil {
		return "", err
	}
	defer func() {
		current, err := os.Lstat(staging)
		if err == nil && current.IsDir() && current.Mode()&os.ModeSymlink == 0 && os.SameFile(before, current) {
			_ = os.RemoveAll(staging)
		}
	}()

	digest := sha256.New()
	err = root.WithReader(ctx, filepath.Base(name), backups.ArchiveLimit, func(input io.Reader) error {
		archive, err := backups.ValidateArchive(ctx, io.TeeReader(input, digest), staging)
		if err != nil {
			return err
		}
		if requireState {
			found := false
			for _, entry := range archive.Entries {
				if entry.Domain == "data" && entry.Path == "state.json" && !entry.Directory {
					found = true
					break
				}
			}
			if !found {
				return backups.ErrInvalid
			}
		}
		return backups.ValidateWorkerBackup(ctx, archive)
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
