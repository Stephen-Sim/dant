package backups

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const AgentDataScope = "agent-data"
const AgentDataSchemaVersion = 2
const AgentDataArchiveMagic = "DANT-BACKUP/2"

// Persisted conversations accept canonical RFC 4122 UUIDs, versions 1 through 5.
// Unrelated workspace directories are excluded before any child is probed.
func agentConversationDirectory(name string) bool {
	id, err := uuid.Parse(name)
	return err == nil && len(name) == 36 && strings.EqualFold(id.String(), name) &&
		id.Version() >= 1 && id.Version() <= 5 && id.Variant() == uuid.RFC4122
}

// agentWorkspaceRoot identifies the application-owned portion of a conversation
// workspace. Projects, browser profiles and execution environments are outside
// these roots even when they share the same conversation directory.
func agentWorkspaceRoot(relative string) (string, bool) {
	if !ValidArchivePath(relative) {
		return "", false
	}
	parts := strings.Split(relative, "/")
	if !agentConversationDirectory(parts[0]) {
		return "", false
	}
	if len(parts) >= 3 && parts[1] == ".agents" && parts[2] == "skills" {
		return strings.Join(parts[:3], "/"), true
	}
	if len(parts) >= 2 && parts[1] == ".dant-disabled-skills" {
		return strings.Join(parts[:2], "/"), true
	}
	return "", false
}

func agentDataRoot(relative string) (string, bool) {
	parts := strings.Split(relative, "/")
	switch parts[0] {
	case "attachments", "schedules", "credentials":
		return parts[0], true
	case "memory":
		if len(parts) >= 2 && parts[1] == "dant" {
			return "memory/dant", true
		}
	}
	return "", false
}

// agentScopeCandidate is checked before opening a child. It permits only owned
// roots and the few ancestors needed to reach them, rather than walking a
// workspace and trying to recognize every possible browser or environment name.
func agentScopeCandidate(domain, relative string) bool {
	if domain == "data" {
		switch relative {
		case "state.json", "telegram.json", "notifications.json", "voice-key.dpapi", "memory":
			return true
		}
		_, owned := agentDataRoot(relative)
		return owned
	}
	if domain != "workspace" {
		return false
	}
	parts := strings.Split(relative, "/")
	if !agentConversationDirectory(parts[0]) {
		return false
	}
	if len(parts) >= 3 && parts[1] == ".agents" && parts[2] == "skills" ||
		len(parts) >= 2 && parts[1] == ".dant-disabled-skills" {
		return true
	}
	return ValidArchivePath(relative) && (len(parts) == 1 || len(parts) == 2 && parts[1] == ".agents")
}

func agentAncestorChildren(domain, prefix string) ([]string, bool) {
	if domain == "data" {
		switch prefix {
		case "":
			return []string{"attachments", "credentials", "memory", "notifications.json", "schedules", "state.json", "telegram.json", "voice-key.dpapi"}, true
		case "memory":
			return []string{"dant"}, true
		}
	}
	if domain == "workspace" {
		parts := strings.Split(prefix, "/")
		if prefix != "" && len(parts) == 1 {
			return []string{".agents", ".dant-disabled-skills"}, true
		}
		if len(parts) == 2 && parts[1] == ".agents" {
			return []string{"skills"}, true
		}
	}
	return nil, false
}

func agentWorkspaceAncestorPresent(directory, relative string) (bool, error) {
	parts := strings.Split(relative, "/")
	if len(parts) != 1 && (len(parts) != 2 || parts[1] != ".agents") {
		return true, nil
	}
	names := []string{"skills"}
	if len(parts) == 1 {
		names = []string{".dant-disabled-skills", ".agents"}
	}
	for _, name := range names {
		path := filepath.Join(directory, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, ErrInvalid
		}
		if name == ".agents" && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			present, err := agentWorkspaceAncestorPresent(path, relative+"/.agents")
			if err != nil {
				return false, err
			}
			if !present {
				continue
			}
		}
		return true, nil
	}
	return false, nil
}

func skillRuntimeDirectory(name string) bool {
	switch name {
	case ".venv", "venv", "node_modules", ".git", ".cache", "cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".nox", "build", "dist":
		return true
	}
	return false
}

func agentArchiveEntryAllowed(domain, relative string, directory bool) bool {
	if !ValidArchivePath(relative) || !agentScopeCandidate(domain, relative) {
		return false
	}
	if domain == "data" {
		if root, owned := agentDataRoot(relative); owned {
			return relative != root || directory
		}
		if relative == "memory" {
			return directory
		}
		return !directory
	}
	root, owned := agentWorkspaceRoot(relative)
	if !owned {
		return directory
	}
	if relative == root {
		return directory
	}
	parts := strings.Split(strings.TrimPrefix(relative, root+"/"), "/")
	for index, part := range parts {
		if index > 0 && skillRuntimeDirectory(part) && (directory || index < len(parts)-1) {
			return false
		}
	}
	return true
}
