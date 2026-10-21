package backups

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

const backupExportLockID = "00000000-0000-0000-0000-000000000000"

type WorkerServiceControl interface {
	Running(context.Context) (bool, error)
	Start(context.Context) error
}

type CLIOptions struct {
	AppVersion string
	Home       string
	Service    WorkerServiceControl
}

type backupCLIArguments struct{ command, data, workspace, id, source string }

func parseBackupCLI(args []string) (backupCLIArguments, error) {
	if len(args) == 0 || len(args)%2 != 1 {
		return backupCLIArguments{}, ErrInvalid
	}
	result := backupCLIArguments{command: args[0]}
	switch result.command {
	case "restore", "inspect", "recover", "export", "finish", "outcome", "preflight":
	default:
		return result, ErrInvalid
	}
	values := map[string]string{}
	for index := 1; index < len(args); index += 2 {
		key, value := args[index], args[index+1]
		switch key {
		case "--data-dir", "--workspace-root", "--restore-id", "--source-id":
		default:
			return result, ErrInvalid
		}
		if _, exists := values[key]; exists || value == "" || strings.ContainsRune(value, 0) {
			return result, ErrInvalid
		}
		values[key] = value
	}
	result.data = values["--data-dir"]
	result.workspace = values["--workspace-root"]
	result.id = values["--restore-id"]
	result.source = values["--source-id"]
	if !filepath.IsAbs(result.data) || !filepath.IsAbs(result.workspace) {
		return result, ErrInvalid
	}

	if result.command == "export" || result.command == "preflight" {
		if result.id != "" || !sourceIdentity.MatchString(result.source) {
			return result, ErrInvalid
		}
		result.id = backupExportLockID
	} else if !restoreID.MatchString(result.id) || result.source != "" {
		return result, ErrInvalid
	}

	return result, nil
}

// RunCLI accepts fixed operation flags. Read-only preflight needs no offline
// lease; all archive mutations retain their existing ownership fences. A failed
// or unconfirmed restoration never starts a worker.
func RunCLI(ctx context.Context, args []string, input io.Reader, output io.Writer, settings ...CLIOptions) error {
	arguments, err := parseBackupCLI(args)
	if err != nil {
		return err
	}
	configuration := CLIOptions{}
	if len(settings) > 1 {
		return ErrInvalid
	}

	if len(settings) == 1 {
		configuration = settings[0]
	}
	if arguments.command == "preflight" {
		footprint, err := PreflightWorkerBackup(ctx, WorkerPreflightOptions{
			DataDir:       arguments.data,
			WorkspaceRoot: arguments.workspace,
			SourceID:      arguments.source,
		})
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(footprint)
	}

	service := configuration.Service
	production := service == nil
	if service == nil {
		service = newSystemdBackupService()
	}
	options := RestoreOptions{DataDir: arguments.data, WorkspaceRoot: arguments.workspace, RestoreID: arguments.id, AssertOffline: func(ctx context.Context) error {
		if production {
			return AssertWorkerOffline(ctx, configuration.Home, arguments.data)
		}
		running, err := service.Running(ctx)
		if err != nil {
			return err
		}
		if running {
			return ErrBusy
		}
		return nil
	}}
	if arguments.command == "restore" {
		if contracts.RuntimeOperatingSystem(runtime.GOOS) == contracts.RuntimeOperatingSystemLinux {
			lock, err := ownership.Acquire(ctx, options.DataDir)
			if err != nil {
				return ErrBusy
			}
			defer lock.Close()
		}
		receipt, err := RestoreWorkerBackup(ctx, options, input)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(receipt)
	}

	if arguments.command == "recover" {
		if contracts.RuntimeOperatingSystem(runtime.GOOS) == contracts.RuntimeOperatingSystemLinux {
			lock, err := ownership.Acquire(ctx, options.DataDir)
			if err != nil {
				return ErrBusy
			}
			defer lock.Close()
		}
		receipt, err := RecoverWorkerRestore(ctx, options)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(receipt)
	}

	return withRestoreLock(ctx, options, func(locations restorePaths) error {
		switch arguments.command {
		case "export":
			if err := assertOffline(ctx, options); err != nil {
				return err
			}
			if contracts.RuntimeOperatingSystem(runtime.GOOS) == contracts.RuntimeOperatingSystemLinux {
				lock, err := ownership.Acquire(ctx, options.DataDir)
				if err != nil {
					return ErrBusy
				}
				defer lock.Close()
			}
			archive, err := CreateWorkerBackup(ctx, WorkerBackupOptions{
				DataDir:         options.DataDir,
				WorkspaceRoot:   options.WorkspaceRoot,
				SourceID:        arguments.source,
				AppVersion:      configuration.AppVersion,
				ValidateCurrent: options.AssertOffline,
			})
			if err != nil {
				return err
			}
			defer archive.Close()
			if err := ValidateWorkerBackup(ctx, archive.Archive); err != nil {
				return err
			}
			if err := assertOffline(ctx, options); err != nil {
				return err
			}
			return archive.WriteTo(ctx, output)
		case "outcome":
			receipt, err := InspectWorkerRestoreRejection(options)
			if err != nil {
				return err
			}
			return json.NewEncoder(output).Encode(receipt)
		case "finish":
			receipt, err := inspectRestore(options, locations)
			if err != nil || !receipt.Restored {
				return ErrRestoreFailed
			}
			running, err := service.Running(ctx)
			if err != nil {
				return err
			}
			if !running {
				if err := service.Start(ctx); err != nil {
					return err
				}
			}
			return json.NewEncoder(output).Encode(receipt)
		case "inspect":
			receipt, err := inspectRestore(options, locations)
			if err != nil {
				return err
			}
			return json.NewEncoder(output).Encode(receipt)
		}
		return ErrInvalid
	})
}
