package backups

import (
	"context"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func inspectScopedComponent(ctx context.Context, locations restorePaths, component scopedRestoreComponent, paths scopedRestorePaths) (map[string]*directoryID, error) {
	if err := checkScopedParents(locations, component); err != nil {
		return nil, err
	}
	identities := make(map[string]*directoryID)
	for _, name := range []string{paths.live, paths.incoming, paths.previous, paths.failed} {
		identity, err := optionalDirectory(name)
		if err != nil {
			return nil, err
		}
		identities[name] = identity
		if identity == nil {
			continue
		}
		if name == paths.previous {
			if !sameOptionalDirectory(identity, component.Original) {
				return nil, ErrRestoreFailed
			}
		} else if *identity != component.Incoming && (name != paths.live || !sameOptionalDirectory(identity, component.Original)) {
			return nil, ErrRestoreFailed
		}
		if *identity == component.Incoming && checkScopedMinimalParent(ctx, component, name) != nil {
			return nil, ErrRestoreFailed
		}
	}
	return identities, nil
}

func checkScopedMinimalParent(ctx context.Context, component scopedRestoreComponent, directory string) error {
	if component.Domain != "workspace" {
		return nil
	}
	if _, owned := agentWorkspaceRoot(component.Path); owned {
		return nil
	}
	// A newly created parent only grants ownership of the minimal skill tree.
	// A later browser/project child is evidence to preserve, never cleanup input.
	count := 0
	return filepath.WalkDir(directory, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.Type()&os.ModeSymlink != 0 {
			return ErrRestoreFailed
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(directory, name)
		if err != nil {
			return ErrRestoreFailed
		}
		path := component.Path
		if relative != "." {
			path += "/" + filepath.ToSlash(relative)
		}
		count++
		if count > MaxFiles || !agentArchiveEntryAllowed("workspace", path, entry.IsDir()) {
			return ErrRestoreFailed
		}
		return nil
	})
}

func removeScopedDirectory(locations restorePaths, component scopedRestoreComponent, name string, expected *directoryID) error {
	if checkScopedParents(locations, component) != nil {
		return ErrRestoreFailed
	}
	identity, err := optionalDirectory(name)
	if err != nil || (identity != nil && !sameOptionalDirectory(identity, expected)) {
		return ErrRestoreFailed
	}
	if identity == nil {
		return nil
	}
	if os.RemoveAll(name) != nil || syncDirectory(filepath.Dir(name)) != nil {
		return ErrRestoreFailed
	}
	return nil
}

func validScopedRecoveryState(component scopedRestoreComponent, paths scopedRestorePaths, identities map[string]*directoryID, committed bool) bool {
	if committed {
		return sameOptionalDirectory(identities[paths.live], &component.Incoming) && identities[paths.incoming] == nil && identities[paths.failed] == nil
	}
	if component.Original != nil {
		originalLive := sameOptionalDirectory(identities[paths.live], component.Original)
		originalPrevious := sameOptionalDirectory(identities[paths.previous], component.Original)
		if originalLive == originalPrevious {
			return false
		}
	}
	incoming := 0
	for _, name := range []string{paths.live, paths.incoming, paths.failed} {
		if identity := identities[name]; identity != nil && *identity == component.Incoming {
			incoming++
		}
	}
	return incoming <= 1
}

func recoverScopedRestore(ctx context.Context, options RestoreOptions, journal restoreJournal) error {
	options.RestoreID = journal.RestoreID
	locations, err := restoreLocations(options)
	if err != nil {
		return err
	}
	// Validate every component before changing any one of them. A replacement
	// retains its evidence and blocks recovery rather than becoming our cleanup.
	for _, component := range journal.Components {
		paths := scopedPaths(locations, component, options.RestoreID)
		identities, err := inspectScopedComponent(ctx, locations, component, paths)
		if err != nil || !validScopedRecoveryState(component, paths, identities, journal.Phase == contracts.WorkerRestorePhaseCommitted) {
			return ErrRestoreFailed
		}
	}
	if journal.Phase != contracts.WorkerRestorePhaseCommitted {
		journal.Phase = contracts.WorkerRestorePhaseRollingBack
		if err := writeRestoreJSON(ctx, locations.journal, journal); err != nil {
			return err
		}
		for index := len(journal.Components) - 1; index >= 0; index-- {
			component := journal.Components[index]
			paths := scopedPaths(locations, component, options.RestoreID)
			identities, err := inspectScopedComponent(ctx, locations, component, paths)
			if err != nil {
				return err
			}
			if live := identities[paths.live]; live != nil && *live == component.Incoming {
				if identities[paths.failed] != nil || identities[paths.incoming] != nil || restoreRename(ctx, options, paths.live, paths.failed) != nil {
					return ErrRestoreFailed
				}
				identities[paths.live] = nil
			}
			if identities[paths.previous] != nil {
				if identities[paths.live] != nil || restoreRename(ctx, options, paths.previous, paths.live) != nil {
					return ErrRestoreFailed
				}
			} else if !sameOptionalDirectory(identities[paths.live], component.Original) {
				return ErrRestoreFailed
			}
		}
	}
	for _, component := range journal.Components {
		paths := scopedPaths(locations, component, options.RestoreID)
		identities, err := inspectScopedComponent(ctx, locations, component, paths)
		if err != nil {
			return err
		}
		if journal.Phase == contracts.WorkerRestorePhaseCommitted {
			if !sameOptionalDirectory(identities[paths.live], &component.Incoming) || identities[paths.incoming] != nil || identities[paths.failed] != nil {
				return ErrRestoreFailed
			}
		} else if !sameOptionalDirectory(identities[paths.live], component.Original) {
			return ErrRestoreFailed
		}
		for _, target := range []struct {
			name string
			id   *directoryID
		}{{paths.incoming, &component.Incoming}, {paths.failed, &component.Incoming}, {paths.previous, component.Original}} {
			if err := removeScopedDirectory(locations, component, target.name, target.id); err != nil {
				return err
			}
		}
	}
	return clearRestoreJSONFile(locations.journal, scopedRestoreJournalMaxBytes)
}
