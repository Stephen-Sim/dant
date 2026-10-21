// Package legacyimport owns the explicit offline import of early desktop
// exports. It never creates a Controller, Engine, model session or scheduler.
package legacyimport

import (
	"errors"
	"regexp"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

const (
	manifestName         = "manifest.json"
	stateName            = "state.json"
	receiptName          = "migration-imported.json"
	journalName          = ".migration-import-pending.json"
	completionName       = ".migration-import-completed.json"
	originalStateName    = ".migration-state-original.json"
	originalManifestName = ".migration-manifest-original.json"
	ownerLockName        = ".dant-core-owner.lock"
	manifestMaxBytes     = 64 * 1024
	stateMaxBytes        = 128 * 1024 * 1024
	receiptMaxBytes      = 2 * 1024 * 1024
	maxLegacyFiles       = 1000
	maxLegacyReferences  = 100000
	maxTotalFileBytes    = int64(512 * 1024 * 1024)
	maxLegacyIDBytes     = 128
	maxManifestIDUnits   = 256
	maxFileBytes         = files.MaxAttachmentBytes
	filesMetadataLimit   = files.MaxAttachmentMetadataBytes
)

var (
	ErrInvalid     = errors.New("legacy_import_invalid")
	ErrConflict    = errors.New("legacy_import_target_not_empty")
	ErrUnconfirmed = errors.New("legacy_import_unconfirmed")
	ErrChanged     = errors.New("legacy_import_source_changed")
	ErrCapacity    = errors.New("legacy_import_capacity")
	ErrBusy        = errors.New("legacy_import_busy")
	legacyID       = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)
	digestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type Options struct {
	SourceDir string
	TargetDir string
}

type Result struct {
	OK          bool `json:"ok"`
	Skipped     bool `json:"skipped"`
	Existing    bool `json:"existing"`
	Files       int  `json:"files"`
	Unavailable int  `json:"unavailable"`
}

type sourceFile struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	Unavailable bool   `json:"unavailable"`
}

type archivedFile struct {
	LegacyID       string `json:"legacyId"`
	ID             string `json:"id"`
	Bytes          int64  `json:"bytes"`
	SHA256         string `json:"sha256"`
	MetadataSHA256 string `json:"metadataSha256"`
}

type journal struct {
	SchemaVersion     int          `json:"schemaVersion"`
	AttemptID         string       `json:"attemptId"`
	ManifestID        string       `json:"manifestId"`
	SourceDir         string       `json:"sourceDir"`
	TargetDir         string       `json:"targetDir"`
	ManifestSHA256    string       `json:"manifestSha256"`
	SourceStateSHA256 string       `json:"sourceStateSha256"`
	Files             []sourceFile `json:"files"`
}

type importProof struct {
	SchemaVersion int            `json:"schemaVersion"`
	AttemptID     string         `json:"attemptId"`
	JournalSHA256 string         `json:"journalSha256"`
	StateSHA256   string         `json:"stateSha256"`
	Files         []archivedFile `json:"files"`
}

type completion struct {
	SchemaVersion int    `json:"schemaVersion"`
	AttemptID     string `json:"attemptId"`
	JournalSHA256 string `json:"journalSha256"`
	ReceiptSHA256 string `json:"receiptSha256"`
}
