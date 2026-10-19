package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
)

// ValidateWorkerBackup is read-only and accepts only a privately extracted,
// already byte-validated archive. It must precede opening any live writer during
// a runtime cutover. An empty fresh data root needs no invented conversation.
func ValidateWorkerBackup(ctx context.Context, archive ValidatedArchive) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !archive.Manifest.Valid() || !filepath.IsAbs(archive.Directory) {
		return ErrInvalid
	}
	data, err := files.OrdinaryDirectory(filepath.Join(archive.Directory, "data"), false)
	if err != nil {
		return ErrInvalid
	}

	raw, err := files.ReadRegular(filepath.Join(data, "state.json"), restoreJSONMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		for _, entry := range archive.Entries {
			if entry.Domain == "data" && !entry.Directory {
				return ErrInvalid
			}
		}
		return nil
	}
	if err != nil {
		return ErrInvalid
	}
	state, err := store.ValidateRestoredState(raw)
	if err != nil || schedules.ValidateBackupRecords(state.Schedules) != nil {
		return ErrInvalid
	}

	for _, database := range []struct {
		path     string
		validate func(context.Context, string) error
	}{
		{filepath.Join(data, "schedules", "schedules.sqlite"), schedules.ValidateBackupDatabase},
		{filepath.Join(data, "memory", "dant", "memory.sqlite"), memory.ValidateBackupDatabase},
	} {
		if _, err := os.Lstat(database.path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return ErrInvalid
		}
		if err := database.validate(ctx, database.path); err != nil {
			return ErrInvalid
		}
	}

	raw, err = files.ReadRegular(filepath.Join(data, "telegram.json"), telegram.MaxConfigBytes)
	if errors.Is(err, os.ErrNotExist) {
		return ctx.Err()
	}
	if err != nil || telegram.ValidateBackupConfig(raw) != nil {
		return ErrInvalid
	}
	return ctx.Err()
}
