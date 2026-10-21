package application

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func beginPreparation(ctx context.Context, startup config.Startup, version, source string) (*preparationTicket, error) {
	root, attempt, journal, err := readInstallation(startup)
	if err != nil || journal == nil {
		return nil, err
	}
	if attempt.Phase != contracts.WorkerInstallationPhasePreparing || !validBackupName(attempt.Backup) ||
		startup.Backup != filepath.Join(root, "installation-backups", attempt.Backup) ||
		attempt.BackupSHA256 != "" || attempt.PreparationSHA256 != "" || attempt.BackupIdentity == "" {
		return nil, ErrActivation
	}

	target, err := installationRoots(startup, root, attempt, false)
	if err != nil || verifyInstallationBundle(ctx, target, attempt, version, source) != nil {
		return nil, ErrActivation
	}

	before, err := backupObservation(startup.Backup, attempt.BackupBytes, attempt.BackupModifiedNS, attempt.BackupIdentity)
	if err != nil {
		return nil, ErrActivation
	}

	return &preparationTicket{
		root:       root,
		journal:    digestBytes(journal),
		attempt:    attempt,
		startup:    startup,
		backupInfo: before,
	}, nil
}

func (ticket *preparationTicket) finish(ctx context.Context, backupHash string) error {
	if ticket == nil {
		return nil
	}
	if !installHash.MatchString(backupHash) {
		return ErrActivation
	}
	if err := ticket.current(ctx); err != nil {
		return err
	}

	receipt := preparationReceipt{
		SchemaVersion:    installationSchema,
		AttemptID:        ticket.attempt.AttemptID,
		Source:           ticket.attempt.Source,
		SourceCommit:     ticket.attempt.SourceCommit,
		Version:          ticket.attempt.Version,
		Directory:        ticket.attempt.Directory,
		DataDir:          ticket.startup.DataDir,
		WorkspaceRoot:    ticket.startup.WorkspaceRoot,
		Backup:           ticket.attempt.Backup,
		BackupBytes:      ticket.attempt.BackupBytes,
		BackupModifiedNS: ticket.attempt.BackupModifiedNS,
		BackupIdentity:   ticket.attempt.BackupIdentity,
		BackupSHA256:     backupHash,
	}

	raw, err := json.Marshal(receipt)
	if err != nil {
		return ErrActivation
	}
	return files.WriteAtomic(ctx, filepath.Join(ticket.root, preparationFile), raw, 0600)
}

func (ticket *preparationTicket) current(ctx context.Context) error {
	if ticket == nil {
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	current, err := files.ReadRegular(filepath.Join(ticket.root, installationJournal), installationLimit)
	if err != nil || digestBytes(current) != ticket.journal {
		return ErrActivation
	}

	info, err := backupObservation(ticket.startup.Backup, ticket.attempt.BackupBytes,
		ticket.attempt.BackupModifiedNS, ticket.attempt.BackupIdentity)
	if err != nil || !os.SameFile(ticket.backupInfo, info) {
		return ErrActivation
	}
	return nil
}
