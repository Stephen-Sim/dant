package backups

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const maxScopedRestoreComponents = MaxFiles + 1
const scopedRestoreJournalMaxBytes = 64 * 1024 * 1024
const scopedRestoreJournalVersion = 2

// Components only replace application data and libraries explicitly present in
// the archive. Missing libraries are not evidence that a live library was deleted.
// A missing conversation or .agents parent is installed as one minimal tree;
// no live workspace parent ever needs replacement or unjournaled creation.
type scopedRestoreComponent struct {
	Domain   string        `json:"domain"`
	Path     string        `json:"path"`
	Original *directoryID  `json:"original"`
	Incoming directoryID   `json:"incoming"`
	Parents  []directoryID `json:"parents"`
}

type scopedRestorePaths struct {
	live, incoming, previous, failed string
}

type scopedRestoreAnchor struct {
	Data, Workspace, DataParent directoryID
}

func validScopedComponent(component scopedRestoreComponent) bool {
	if !component.Incoming.valid() || (component.Original != nil && (!component.Original.valid() || *component.Original == component.Incoming)) {
		return false
	}
	for _, identity := range component.Parents {
		if !identity.valid() {
			return false
		}
	}
	if component.Domain == "data" {
		return component.Path == "" && component.Original != nil && len(component.Parents) == 1
	}
	if component.Domain != "workspace" || !ValidArchivePath(component.Path) {
		return false
	}
	parts := strings.Split(component.Path, "/")
	if !agentConversationDirectory(parts[0]) || len(component.Parents) != len(parts) {
		return false
	}
	switch len(parts) {
	case 1:
		return component.Original == nil
	case 2:
		return parts[1] == ".dant-disabled-skills" || (parts[1] == ".agents" && component.Original == nil)
	case 3:
		return parts[1] == ".agents" && parts[2] == "skills"
	default:
		return false
	}
}

func readScopedRestoreJournal(raw []byte, journal restoreJournal, object contracts.RawObject) (*restoreJournal, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&journal) != nil || !validScopedRestoreJournal(journal) ||
		!required(object, "schemaVersion", "scope", "restoreId", "phase", "data", "workspace", "components") {
		return nil, ErrRestoreFailed
	}
	var components []contracts.RawObject
	if json.Unmarshal(object["components"], &components) != nil {
		return nil, ErrRestoreFailed
	}
	for _, component := range components {
		if !required(component, "domain", "path", "original", "incoming", "parents") {
			return nil, ErrRestoreFailed
		}
	}
	return &journal, nil
}

func validScopedRestoreJournal(journal restoreJournal) bool {
	if journal.SchemaVersion != scopedRestoreJournalVersion ||
		!restoreID.MatchString(journal.RestoreID) || !journal.Phase.Valid() ||
		journal.Scope != AgentDataScope || journal.Data != (directoryID{}) ||
		journal.Workspace != (directoryID{}) || len(journal.Components) == 0 ||
		len(journal.Components) > maxScopedRestoreComponents {
		return false
	}
	if journal.Components[0].Domain != "data" {
		return false
	}
	seen := make(map[string]bool)
	parents := make(map[string]bool)
	identities := make(map[directoryID]bool)
	for index, component := range journal.Components {
		key := component.Domain + "/" + strings.ToLower(component.Path)
		if !validScopedComponent(component) || seen[key] || parents[key] ||
			identities[component.Incoming] || (component.Original != nil && identities[*component.Original]) ||
			(index != 0 && component.Domain != "workspace") {
			return false
		}
		segments := strings.Split(key, "/")
		for length := 1; length < len(segments); length++ {
			ancestor := strings.Join(segments[:length], "/")
			if seen[ancestor] {
				return false
			}
			parents[ancestor] = true
		}
		seen[key] = true
		identities[component.Incoming] = true
		if component.Original != nil {
			identities[*component.Original] = true
		}
	}
	return true
}

func scopedPaths(locations restorePaths, component scopedRestoreComponent, id string) scopedRestorePaths {
	if component.Domain == "data" {
		return scopedRestorePaths{locations.data, locations.dataNew, locations.dataPrevious, locations.dataFailed}
	}
	live := filepath.Join(locations.workspace, filepath.FromSlash(component.Path))
	sum := sha256.Sum256([]byte(component.Path))
	base := filepath.Join(filepath.Dir(live), ".dant-restore-"+id+"-"+hex.EncodeToString(sum[:])[:16])
	return scopedRestorePaths{live, base + ".new", base + ".previous", base + ".failed"}
}

func scopedParents(locations restorePaths, component scopedRestoreComponent) []string {
	if component.Domain == "data" {
		return []string{locations.dataParent}
	}
	parents := []string{locations.workspace}
	current := locations.workspace
	parts := strings.Split(component.Path, "/")
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		parents = append(parents, current)
	}
	return parents
}

func checkScopedParents(locations restorePaths, component scopedRestoreComponent) error {
	parents := scopedParents(locations, component)
	if len(parents) != len(component.Parents) {
		return ErrRestoreFailed
	}
	for index, name := range parents {
		identity, err := ordinaryIdentity(name)
		if err != nil || identity != component.Parents[index] {
			return ErrRestoreFailed
		}
	}
	return nil
}

func optionalDirectory(name string) (*directoryID, error) {
	if _, err := os.Lstat(name); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, ErrRestoreFailed
	}
	identity, err := ordinaryIdentity(name)
	if err != nil {
		return nil, ErrRestoreFailed
	}
	return &identity, nil
}

func scopedComponentSource(archive ValidatedArchive, workspace string, component scopedRestoreComponent) string {
	if component.Domain == "workspace" {
		return filepath.Join(workspace, filepath.FromSlash(component.Path))
	}
	return filepath.Join(archive.Directory, "data")
}

func sameOptionalDirectory(left, right *directoryID) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}
