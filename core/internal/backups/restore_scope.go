package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func scopedComponents(locations restorePaths, archive ValidatedArchive, workspaceSource string) ([]scopedRestoreComponent, error) {
	roots := make(map[string]bool)
	for _, entry := range archive.Entries {
		if entry.Domain != "workspace" {
			continue
		}
		if root, included := agentWorkspaceRoot(entry.Path); included {
			roots[root] = true
		}
	}
	selected := make(map[string]bool)
	for root := range roots {
		parts := strings.Split(root, "/")
		conversation := filepath.Join(locations.workspace, parts[0])
		identity, err := optionalDirectory(conversation)
		if err != nil {
			return nil, err
		}
		if identity == nil {
			selected[parts[0]] = true
			continue
		}
		if parts[1] == ".agents" {
			identity, err = optionalDirectory(filepath.Join(conversation, ".agents"))
			if err != nil {
				return nil, err
			}
			if identity == nil {
				selected[parts[0]+"/.agents"] = true
				continue
			}
		}
		selected[root] = true
	}
	ordered := make([]string, 0, len(selected))
	for root := range selected {
		ordered = append(ordered, root)
	}
	sort.Strings(ordered)
	components := []scopedRestoreComponent{{Domain: "data"}}
	for _, name := range ordered {
		components = append(components, scopedRestoreComponent{Domain: "workspace", Path: name})
	}
	if len(components) > maxScopedRestoreComponents {
		return nil, ErrRestoreFailed
	}
	for index := range components {
		component := &components[index]
		source := scopedComponentSource(archive, workspaceSource, *component)
		incoming, err := ordinaryIdentity(source)
		if err != nil {
			return nil, err
		}
		component.Incoming = incoming
		live := scopedPaths(locations, *component, "").live
		component.Original, err = optionalDirectory(live)
		if err != nil {
			return nil, err
		}
		for _, name := range scopedParents(locations, *component) {
			identity, err := ordinaryIdentity(name)
			if err != nil {
				return nil, err
			}
			component.Parents = append(component.Parents, identity)
		}
		if !validScopedComponent(*component) {
			return nil, ErrRestoreFailed
		}
	}

	return components, nil
}

func restoreAgentData(ctx context.Context, options RestoreOptions, locations restorePaths, archive ValidatedArchive, storage restoreStorage, anchor scopedRestoreAnchor) (RestoreReceipt, error) {
	receipt := RestoreReceipt{RestoreID: options.RestoreID}
	workspace, err := ordinaryIdentity(locations.workspace)
	if err != nil || workspace != anchor.Workspace {
		return receipt, ErrRestoreFailed
	}

	workspaceSource, cleanup, err := stageScopedWorkspace(ctx, locations, archive, storage)
	if err != nil {
		return receipt, err
	}
	defer cleanup()

	components, err := scopedComponents(locations, archive, workspaceSource)
	if err != nil {
		return receipt, err
	}
	if !sameOptionalDirectory(components[0].Original, &anchor.Data) || components[0].Parents[0] != anchor.DataParent {
		return receipt, ErrRestoreFailed
	}
	for _, component := range components {
		if component.Domain == "workspace" && component.Parents[0] != anchor.Workspace {
			return receipt, ErrRestoreFailed
		}
		paths := scopedPaths(locations, component, options.RestoreID)
		for _, name := range []string{paths.incoming, paths.previous, paths.failed} {
			if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
				return receipt, ErrRestoreFailed
			}
		}
		if err := storage.flushTree(ctx, scopedComponentSource(archive, workspaceSource, component)); err != nil {
			return receipt, err
		}
	}

	journal := restoreJournal{
		SchemaVersion: scopedRestoreJournalVersion,
		Scope:         AgentDataScope,
		RestoreID:     options.RestoreID,
		Phase:         contracts.WorkerRestorePhasePrepared,
		Components:    components,
	}
	if !validScopedRestoreJournal(journal) {
		return receipt, ErrRestoreFailed
	}
	if err := storage.writeJSON(ctx, locations.journal, journal); err != nil {
		return receipt, err
	}
	for _, component := range components {
		if checkScopedParents(locations, component) != nil {
			return receipt, ErrRestoreFailed
		}
		paths := scopedPaths(locations, component, options.RestoreID)
		if err := restoreRename(ctx, options, scopedComponentSource(archive, workspaceSource, component), paths.incoming); err != nil {
			return receipt, ErrRestoreFailed
		}
	}

	if err := assertOffline(ctx, options); err != nil {
		return receipt, err
	}
	journal.Phase = contracts.WorkerRestorePhaseInstalling
	if err := storage.writeJSON(ctx, locations.journal, journal); err != nil {
		return receipt, err
	}
	for _, component := range components {
		paths := scopedPaths(locations, component, options.RestoreID)
		identities, err := inspectScopedComponent(ctx, locations, component, paths)
		if err != nil || !sameOptionalDirectory(identities[paths.live], component.Original) ||
			!sameOptionalDirectory(identities[paths.incoming], &component.Incoming) ||
			identities[paths.previous] != nil || identities[paths.failed] != nil {
			return receipt, ErrRestoreFailed
		}
		if component.Original != nil {
			if err := restoreRename(ctx, options, paths.live, paths.previous); err != nil {
				return receipt, ErrRestoreFailed
			}
		}
		if err := restoreRename(ctx, options, paths.incoming, paths.live); err != nil {
			return receipt, ErrRestoreFailed
		}
	}

	journal.Phase = contracts.WorkerRestorePhaseCommitted
	if err := storage.writeJSON(ctx, locations.journal, journal); err != nil {
		return receipt, err
	}
	if err := recoverScopedRestore(ctx, options, journal); err != nil {
		return receipt, err
	}
	receipt.Restored = true

	return receipt, nil
}

func stageScopedWorkspace(ctx context.Context, locations restorePaths, archive ValidatedArchive, storage restoreStorage) (string, func(), error) {
	directory, err := os.MkdirTemp(locations.workspace, ".dant-restore-workspace-")
	if err != nil {
		return "", nil, ErrRestoreFailed
	}
	identity, err := files.CaptureIdentity(directory)
	if err != nil {
		return "", nil, ErrRestoreFailed
	}

	cleanup := func() {
		current, err := os.Lstat(directory)
		if err == nil && current.IsDir() && os.SameFile(identity, current) && filepath.Dir(directory) == locations.workspace {
			_ = os.RemoveAll(directory)
		}
	}
	target := filepath.Join(directory, "workspace")
	if err := storage.copyTree(ctx, filepath.Join(archive.Directory, "workspace"), target); err != nil {
		cleanup()
		return "", nil, err
	}

	return target, cleanup, nil
}
