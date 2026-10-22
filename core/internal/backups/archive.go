// Package backups owns bounded backup archives and explicit recovery transactions.
package backups

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const ArchiveMagic = "DANT-BACKUP/1"
const MaxBackupBytes = int64(10 * 1024 * 1024 * 1024)
const MaxFileBytes = int64(2 * 1024 * 1024 * 1024)
const MaxFiles = 100000
const MaxFrameBytes = 1024 * 1024
const ChunkBytes = 64 * 1024
const MaxArchivePathBytes = 4096

var ErrInvalid = errors.New("backup_invalid")
var ErrSizeLimit = errors.New("backup_size_limit")
var ErrSourceChanged = errors.New("backup_source_changed")
var archiveHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var archiveVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$`)
var sourceIdentity = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var reservedPath = regexp.MustCompile(`(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)`)

type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Scope         string `json:"scope,omitempty"`
	CreatedAt     int64  `json:"createdAt"`
	AppVersion    string `json:"appVersion"`
	SourceID      string `json:"sourceId"`
	Files         int    `json:"files"`
	Bytes         int64  `json:"bytes"`
}

func (manifest Manifest) Valid() bool {
	validSchema := manifest.SchemaVersion == 1 && manifest.Scope == "" ||
		manifest.SchemaVersion == AgentDataSchemaVersion && manifest.Scope == AgentDataScope
	return validSchema && manifest.CreatedAt > 0 && manifest.CreatedAt <= 9007199254740991 && archiveVersion.MatchString(manifest.AppVersion) && sourceIdentity.MatchString(manifest.SourceID) && manifest.Files >= 0 && manifest.Files <= MaxFiles && manifest.Bytes >= 0 && manifest.Bytes <= MaxBackupBytes
}

type ArchiveEntry struct {
	Domain     string
	Path       string
	Directory  bool
	Size       int64
	Executable bool
	SHA256     string
}

type ValidatedArchive struct {
	Manifest  Manifest
	Directory string
	Entries   []ArchiveEntry
}

type archiveFrame struct {
	Type string `json:"type"`
	Manifest
	Domain     string `json:"domain"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	Executable *bool  `json:"executable"`
	Data       string `json:"data"`
	SHA256     string `json:"sha256"`
}

func ValidArchivePath(value string) bool {
	if value == "" || len(value) > MaxArchivePathBytes || !utf8.ValidString(value) || strings.HasPrefix(value, "/") {
		return false
	}
	for _, character := range value {
		if character == '\\' || character == ':' || character <= 0x1f || character == 0x7f {
			return false
		}
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || reservedPath.MatchString(part) {
			return false
		}
	}

	return true
}

func required(object contracts.RawObject, names ...string) bool {
	for _, name := range names {
		if _, exists := object[name]; !exists {
			return false
		}
	}

	return true
}

// ValidateArchive only writes into a newly empty private staging root. Each file
// is authenticated by its exact raw-byte hash before any live restore is allowed.
func ValidateArchive(ctx context.Context, input io.Reader, staging string) (ValidatedArchive, error) {
	absolute, err := files.OrdinaryDirectory(staging, false)
	if err != nil {
		return ValidatedArchive{}, ErrInvalid
	}
	before, err := files.CaptureIdentity(absolute)
	if err != nil {
		return ValidatedArchive{}, ErrInvalid
	}
	names, err := os.ReadDir(absolute)
	if err != nil || len(names) != 0 {
		return ValidatedArchive{}, ErrInvalid
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return ValidatedArchive{}, ErrInvalid
	}
	defer root.Close()
	unchanged := func() bool {
		current, err := os.Lstat(absolute)
		return err == nil && current.IsDir() && current.Mode()&os.ModeSymlink == 0 && os.SameFile(before, current)
	}
	for _, domain := range []string{"data", "workspace"} {
		if err := root.Mkdir(domain, 0700); err != nil {
			return ValidatedArchive{}, ErrInvalid
		}
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, ChunkBytes), MaxFrameBytes+1)
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			return newline + 1, data[:newline], nil
		}
		if atEOF && len(data) > 0 {
			return 0, nil, io.ErrUnexpectedEOF
		}
		return 0, nil, nil
	})
	var manifest *Manifest
	entries := []ArchiveEntry{}
	seen := make(map[string]bool)
	parents := make(map[string]struct{})
	index := 0
	magic := ""
	count := 0
	total := int64(0)
	footer := false
	var current *os.File
	var currentHash hash.Hash
	var currentEntry *ArchiveEntry
	written := int64(0)
	defer func() {
		if current != nil {
			current.Close()
		}
	}()
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return ValidatedArchive{}, err
		}
		if !unchanged() {
			return ValidatedArchive{}, ErrSourceChanged
		}
		line := scanner.Bytes()
		if len(line) > MaxFrameBytes || !utf8.Valid(line) {
			return ValidatedArchive{}, ErrInvalid
		}
		if index == 0 {
			index++
			magic = string(line)
			if magic != ArchiveMagic && magic != AgentDataArchiveMagic {
				return ValidatedArchive{}, ErrInvalid
			}
			continue
		}
		index++
		object, err := contracts.DecodeObject(line, MaxFrameBytes)
		if err != nil || footer {
			return ValidatedArchive{}, ErrInvalid
		}
		var frame archiveFrame
		if json.Unmarshal(line, &frame) != nil {
			return ValidatedArchive{}, ErrInvalid
		}
		if manifest == nil {
			if frame.Type != "header" || !required(object, "schemaVersion", "createdAt", "appVersion", "sourceId", "files", "bytes") || !frame.Manifest.Valid() {
				return ValidatedArchive{}, ErrInvalid
			}
			_, scoped := object["scope"]
			if frame.SchemaVersion == 1 && (scoped || magic != ArchiveMagic) ||
				frame.SchemaVersion == AgentDataSchemaVersion && (!scoped || len(object) != 8 || magic != AgentDataArchiveMagic) {
				return ValidatedArchive{}, ErrInvalid
			}
			copy := frame.Manifest
			manifest = &copy
			continue
		}
		if current != nil {
			if frame.Type == "chunk" {
				if frame.Data == "" || len(frame.Data) > base64.StdEncoding.EncodedLen(ChunkBytes) {
					return ValidatedArchive{}, ErrInvalid
				}
				chunk, err := base64.StdEncoding.Strict().DecodeString(frame.Data)
				if err != nil || len(chunk) > ChunkBytes || base64.StdEncoding.EncodeToString(chunk) != frame.Data || written+int64(len(chunk)) > currentEntry.Size {
					return ValidatedArchive{}, ErrInvalid
				}
				if _, err := current.Write(chunk); err != nil {
					return ValidatedArchive{}, ErrInvalid
				}
				currentHash.Write(chunk)
				written += int64(len(chunk))
				continue
			}
			if frame.Type != "end" || !archiveHash.MatchString(frame.SHA256) || written != currentEntry.Size || hex.EncodeToString(currentHash.Sum(nil)) != frame.SHA256 {
				return ValidatedArchive{}, ErrInvalid
			}
			if current.Sync() != nil {
				return ValidatedArchive{}, ErrInvalid
			}
			if current.Close() != nil {
				return ValidatedArchive{}, ErrInvalid
			}
			current = nil
			currentEntry.SHA256 = frame.SHA256
			currentEntry = nil
			continue
		}
		if frame.Type == "footer" {
			if frame.Files != count || frame.Bytes != total || count != manifest.Files || total != manifest.Bytes || !required(object, "files", "bytes") {
				return ValidatedArchive{}, ErrInvalid
			}
			footer = true
			continue
		}
		if (frame.Type != "file" && frame.Type != "directory") || (frame.Domain != "data" && frame.Domain != "workspace") || !ValidArchivePath(frame.Path) || frame.Size < 0 || frame.Size > MaxFileBytes || frame.Executable == nil || !required(object, "size") || (frame.Type == "directory" && frame.Size != 0) || len(entries) >= MaxFiles {
			return ValidatedArchive{}, ErrInvalid
		}
		if manifest.Scope == AgentDataScope && !agentArchiveEntryAllowed(frame.Domain, frame.Path, frame.Type == "directory") {
			return ValidatedArchive{}, ErrInvalid
		}
		if manifest.Scope == AgentDataScope && frame.Domain == "workspace" {
			if root, owned := agentWorkspaceRoot(frame.Path); owned && frame.Path != root && !seen["workspace/"+root] {
				return ValidatedArchive{}, ErrInvalid
			}
		}
		key := frame.Domain + "/" + frame.Path
		if _, exists := seen[key]; exists {
			return ValidatedArchive{}, ErrInvalid
		}
		segments := strings.Split(key, "/")
		for length := 1; length < len(segments); length++ {
			parent := strings.Join(segments[:length], "/")
			if directory, exists := seen[parent]; exists && !directory {
				return ValidatedArchive{}, ErrInvalid
			}
			parents[parent] = struct{}{}
		}
		if frame.Type == "file" {
			if _, parent := parents[key]; parent {
				return ValidatedArchive{}, ErrInvalid
			}
		}
		seen[key] = frame.Type == "directory"
		entry := ArchiveEntry{Domain: frame.Domain, Path: frame.Path, Directory: frame.Type == "directory", Size: frame.Size, Executable: *frame.Executable}
		entries = append(entries, entry)
		target := filepath.Join(absolute, frame.Domain, filepath.FromSlash(frame.Path))
		if _, err := files.OrdinaryDirectory(filepath.Dir(target), true); err != nil || !unchanged() {
			return ValidatedArchive{}, ErrInvalid
		}
		if entry.Directory {
			if _, err := files.OrdinaryDirectory(target, true); err != nil {
				return ValidatedArchive{}, ErrInvalid
			}
			continue
		}
		count++
		total += entry.Size
		if count > manifest.Files || total > manifest.Bytes || total > MaxBackupBytes {
			return ValidatedArchive{}, ErrInvalid
		}
		mode := os.FileMode(0600)
		if entry.Executable {
			mode = 0700
		}
		current, err = root.OpenFile(filepath.Join(frame.Domain, filepath.FromSlash(frame.Path)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return ValidatedArchive{}, ErrInvalid
		}
		currentEntry = &entries[len(entries)-1]
		written = 0
		currentHash = sha256.New()
	}

	if err := ctx.Err(); err != nil {
		return ValidatedArchive{}, err
	}

	if scanner.Err() != nil || manifest == nil || !footer || current != nil || !unchanged() {
		return ValidatedArchive{}, ErrInvalid
	}

	if directory, exists := seen["data/state.json"]; !exists || directory {
		return ValidatedArchive{}, ErrInvalid
	}

	return ValidatedArchive{Manifest: *manifest, Directory: absolute, Entries: entries}, nil
}

// WriteArchive retains original file bytes; cancellation or a changed file aborts
// the transfer rather than returning a successful partial backup.
func WriteArchive(ctx context.Context, output io.Writer, archive ValidatedArchive) error {
	if !archive.Manifest.Valid() || len(archive.Entries) > MaxFiles {
		return ErrInvalid
	}

	if _, err := files.OrdinaryDirectory(archive.Directory, false); err != nil {
		return ErrInvalid
	}

	magic := ArchiveMagic
	if archive.Manifest.Scope == AgentDataScope {
		magic = AgentDataArchiveMagic
	}
	if _, err := io.WriteString(output, magic+"\n"); err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(struct {
		Type string `json:"type"`
		Manifest
	}{"header", archive.Manifest}); err != nil {
		return err
	}
	count := 0
	total := int64(0)
	workspaceRoots := make(map[string]bool)
	for _, entry := range archive.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !ValidArchivePath(entry.Path) || (entry.Domain != "data" && entry.Domain != "workspace") || entry.Size < 0 || entry.Size > MaxFileBytes {
			return ErrInvalid
		}
		if archive.Manifest.Scope == AgentDataScope && !agentArchiveEntryAllowed(entry.Domain, entry.Path, entry.Directory) {
			return ErrInvalid
		}
		if archive.Manifest.Scope == AgentDataScope && entry.Domain == "workspace" {
			if root, owned := agentWorkspaceRoot(entry.Path); owned {
				if entry.Path == root {
					workspaceRoots[root] = true
				} else if !workspaceRoots[root] {
					return ErrInvalid
				}
			}
		}
		kind := "file"
		if entry.Directory {
			kind = "directory"
		}
		if err := encoder.Encode(struct {
			Type       string `json:"type"`
			Domain     string `json:"domain"`
			Path       string `json:"path"`
			Size       int64  `json:"size"`
			Executable bool   `json:"executable"`
		}{kind, entry.Domain, entry.Path, entry.Size, entry.Executable}); err != nil {
			return err
		}
		if entry.Directory {
			continue
		}
		name := filepath.Join(archive.Directory, entry.Domain, filepath.FromSlash(entry.Path))
		if _, err := files.OrdinaryDirectory(filepath.Dir(name), false); err != nil {
			return ErrSourceChanged
		}
		before, err := os.Lstat(name)
		if err != nil || !before.Mode().IsRegular() || before.Size() != entry.Size {
			return ErrSourceChanged
		}
		input, err := os.Open(name)
		if err != nil {
			return ErrSourceChanged
		}
		readErr := func() error {
			defer input.Close()
			opened, err := input.Stat()
			if err != nil || !os.SameFile(before, opened) || !stageSingleLink(input) {
				return ErrSourceChanged
			}
			hash := sha256.New()
			bytes := int64(0)
			buffer := make([]byte, ChunkBytes)
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				length, err := input.Read(buffer)
				if length > 0 {
					bytes += int64(length)
					if bytes > entry.Size {
						return ErrSourceChanged
					}
					hash.Write(buffer[:length])
					if writeErr := encoder.Encode(struct {
						Type string `json:"type"`
						Data string `json:"data"`
					}{"chunk", base64.StdEncoding.EncodeToString(buffer[:length])}); writeErr != nil {
						return writeErr
					}
				}
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					return ErrSourceChanged
				}
			}
			after, err := os.Lstat(name)
			if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || !stageSingleLink(input) || bytes != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
				return ErrSourceChanged
			}
			return encoder.Encode(struct {
				Type   string `json:"type"`
				SHA256 string `json:"sha256"`
			}{"end", entry.SHA256})
		}()
		if readErr != nil {
			return readErr
		}
		count++
		total += entry.Size
	}

	if count != archive.Manifest.Files || total != archive.Manifest.Bytes {
		return ErrInvalid
	}

	return encoder.Encode(struct {
		Type  string `json:"type"`
		Files int    `json:"files"`
		Bytes int64  `json:"bytes"`
	}{"footer", count, total})
}
