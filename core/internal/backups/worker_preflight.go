package backups

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

const PreflightAllocationUnitBytes int64 = 64 * 1024
const PreflightHeadroomBytes int64 = 1024 * 1024 * 1024

const preflightDirectoryBatch = 128
const preflightArchiveEnvelopeBytes int64 = MaxFrameBytes
const preflightChunkFrameBytes int64 = int64(len(`{"type":"chunk","data":""}`) + 1)
const preflightEndFrameBytes int64 = int64(len(`{"type":"end","sha256":""}`) + 64 + 1)

type WorkerPreflightOptions struct {
	DataDir       string
	WorkspaceRoot string
	SourceID      string
}

// WorkerFootprint is a conservative capacity estimate, never a backup receipt.
// Data SQLite sidecars remain included: no database is opened during preflight.
type WorkerFootprint struct {
	Files         int   `json:"files"`
	ContentBytes  int64 `json:"contentBytes"`
	DataBytes     int64 `json:"dataBytes"`
	StagingBytes  int64 `json:"stagingBytes"`
	ArchiveBytes  int64 `json:"archiveBytes"`
	RequiredBytes int64 `json:"requiredBytes"`
}

type footprintScanner struct {
	ctx          context.Context
	workspace    string
	observed     workerCapture
	entries      int
	directories  int
	pathsBytes   int64
	chunkCount   int64
	paddingBytes int64
	footprint    WorkerFootprint
}

// PreflightWorkerBackup reads metadata only inside the selected agent roots.
// It creates no directories, locks, snapshots or SQLite connections. A changed
// owned source or unknown file type cannot become a successful capacity estimate.
func PreflightWorkerBackup(ctx context.Context, options WorkerPreflightOptions) (WorkerFootprint, error) {
	if err := ctx.Err(); err != nil {
		return WorkerFootprint{}, err
	}
	if !filepath.IsAbs(options.DataDir) ||
		!filepath.IsAbs(options.WorkspaceRoot) ||
		!sourceIdentity.MatchString(options.SourceID) {
		return WorkerFootprint{}, ErrInvalid
	}
	data, err := files.OrdinaryDirectory(options.DataDir, false)
	if err != nil {
		return WorkerFootprint{}, ErrInvalid
	}

	workspace, err := files.OrdinaryDirectory(options.WorkspaceRoot, false)
	if err != nil || data == workspace || containsRoot(workspace, data) {
		return WorkerFootprint{}, ErrInvalid
	}

	if _, err := ordinaryBackupFile(filepath.Join(data, "state.json")); err != nil {
		return WorkerFootprint{}, err
	}

	scanner := footprintScanner{
		ctx:         ctx,
		workspace:   workspace,
		observed:    workerCapture{ctx: ctx},
		directories: 2,
	}
	for _, domain := range []struct{ name, source string }{{"data", data}, {"workspace", workspace}} {
		if err := scanner.directory(domain.source, domain.name, ""); err != nil {
			return WorkerFootprint{}, err
		}
	}

	if err := scanner.observed.validate(); err != nil {
		return WorkerFootprint{}, err
	}

	result := scanner.footprint
	result.StagingBytes += int64(scanner.directories) * PreflightAllocationUnitBytes
	result.ArchiveBytes = preflightArchiveEnvelopeBytes + scanner.pathsBytes +
		4*((result.ContentBytes+2)/3) + scanner.paddingBytes +
		scanner.chunkCount*preflightChunkFrameBytes + int64(result.Files)*preflightEndFrameBytes
	result.RequiredBytes = result.StagingBytes + result.ArchiveBytes + PreflightHeadroomBytes
	return result, nil
}

func (scanner *footprintScanner) directory(directory, domain, prefix string) error {
	if err := scanner.ctx.Err(); err != nil {
		return err
	}
	before, err := os.Lstat(directory)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return ErrInvalid
	}
	if _, bounded := agentAncestorChildren(domain, prefix); bounded {
		if err := scanner.observed.observe(directory, before); err != nil {
			return err
		}
		children, err := scanner.observed.children(directory, domain, prefix)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := scanner.child(directory, domain, prefix, child.Name()); err != nil {
				return err
			}
		}
		return nil
	}
	input, err := os.Open(directory)
	if err != nil {
		return ErrInvalid
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return ErrSourceChanged
	}
	if err := scanner.observed.observe(directory, before); err != nil {
		return err
	}

	for {
		if err := scanner.ctx.Err(); err != nil {
			return err
		}
		children, readErr := input.ReadDir(preflightDirectoryBatch)
		for _, child := range children {
			if err := scanner.child(directory, domain, prefix, child.Name()); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return ErrInvalid
		}
	}
	return nil
}

func (scanner *footprintScanner) child(directory, domain, prefix, name string) error {
	if err := scanner.ctx.Err(); err != nil {
		return err
	}
	source := filepath.Join(directory, name)
	relative := name
	if prefix != "" {
		relative = prefix + "/" + name
	}
	if !agentScopeCandidate(domain, relative) {
		return nil
	}
	if domain == "data" && containsRoot(scanner.workspace, source) {
		return nil
	}
	if !ValidArchivePath(relative) {
		return ErrInvalid
	}
	info, err := os.Lstat(source)
	if err != nil {
		return ErrInvalid
	}
	if !agentArchiveEntryAllowed(domain, relative, info.IsDir()) {
		if domain == "workspace" && info.IsDir() && skillRuntimeDirectory(name) {
			return nil
		}
		return ErrInvalid
	}
	if domain == "workspace" && info.IsDir() {
		present, err := agentWorkspaceAncestorPresent(source, relative)
		if err != nil {
			return err
		}
		if !present {
			return nil
		}
	}
	if scanner.entries >= MaxFiles || info.Mode()&os.ModeSymlink != 0 {
		return ErrInvalid
	}
	scanner.entries++

	if info.IsDir() {
		scanner.directories++
		if err := scanner.entryFrame(domain, relative, true); err != nil {
			return err
		}
		return scanner.directory(source, domain, relative)
	}
	if _, err := ordinaryBackupFile(source); err != nil {
		return err
	}
	if err := scanner.observed.observe(source, info); err != nil {
		return err
	}
	if err := scanner.entryFrame(domain, relative, false); err != nil {
		return err
	}

	if info.Size() < 0 ||
		info.Size() > MaxFileBytes ||
		scanner.footprint.ContentBytes > MaxBackupBytes-info.Size() {
		return ErrSizeLimit
	}
	scanner.footprint.Files++
	scanner.footprint.ContentBytes += info.Size()
	if domain == "data" {
		scanner.footprint.DataBytes += info.Size()
	}
	allocationUnits := (info.Size() + PreflightAllocationUnitBytes - 1) / PreflightAllocationUnitBytes
	scanner.footprint.StagingBytes += allocationUnits * PreflightAllocationUnitBytes
	chunks := (info.Size() + ChunkBytes - 1) / ChunkBytes
	scanner.chunkCount += chunks
	// Each file and chunk can add up to two bytes of base64 padding.
	scanner.paddingBytes += 4 + 4*chunks
	return nil
}

func (scanner *footprintScanner) entryFrame(domain, relative string, directory bool) error {
	kind := "file"
	if directory {
		kind = "directory"
	}
	frame, err := json.Marshal(struct {
		Type       string `json:"type"`
		Domain     string `json:"domain"`
		Path       string `json:"path"`
		Size       int64  `json:"size"`
		Executable bool   `json:"executable"`
	}{
		Type:       kind,
		Domain:     domain,
		Path:       relative,
		Size:       MaxFileBytes,
		Executable: false,
	})
	if err != nil {
		return ErrInvalid
	}
	scanner.pathsBytes += int64(len(frame) + 1)
	return nil
}
