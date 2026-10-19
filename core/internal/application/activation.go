package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const (
	installationJournal      = "install-attempt.json"
	preparationFile          = "worker-preparation.json"
	installationLimit        = 64 * 1024
	installationSchema       = 1
	installationVersionLimit = 100
	preparationFieldCount    = 13
)

var (
	ErrActivation = errors.New("worker_activation_unconfirmed")
	installUUID   = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
	installHash   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	installCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)
	installSource = regexp.MustCompile(`^source\.[A-Za-z0-9._-]{1,160}$`)
	installTime   = regexp.MustCompile(`^-?[0-9]{1,20}$`)
	installFileID = regexp.MustCompile(`^[a-f0-9]{1,16}:[a-f0-9]{1,16}$`)
)

type installationAttempt struct {
	SchemaVersion int                               `json:"schemaVersion"`
	AttemptID     string                            `json:"attemptId"`
	Source        string                            `json:"source"`
	SourceCommit  string                            `json:"sourceCommit"`
	Version       string                            `json:"version"`
	Directory     string                            `json:"directory"`
	Phase         contracts.WorkerInstallationPhase `json:"phase"`

	Backup            string `json:"backup,omitempty"`
	BackupBytes       int64  `json:"backupBytes,omitempty"`
	BackupModifiedNS  string `json:"backupModifiedNS,omitempty"`
	BackupIdentity    string `json:"backupIdentity,omitempty"`
	BackupSHA256      string `json:"backupSha256,omitempty"`
	PreparationSHA256 string `json:"preparationSha256,omitempty"`
	MaintenanceID     string `json:"maintenanceId,omitempty"`
}

type preparationReceipt struct {
	SchemaVersion int    `json:"schemaVersion"`
	AttemptID     string `json:"attemptId"`
	Source        string `json:"source"`
	SourceCommit  string `json:"sourceCommit"`
	Version       string `json:"version"`
	Directory     string `json:"directory"`
	DataDir       string `json:"dataDir"`
	WorkspaceRoot string `json:"workspaceRoot"`

	Backup           string `json:"backup"`
	BackupBytes      int64  `json:"backupBytes"`
	BackupModifiedNS string `json:"backupModifiedNS"`
	BackupIdentity   string `json:"backupIdentity"`
	BackupSHA256     string `json:"backupSha256"`
}

type preparationTicket struct {
	root       string
	journal    string
	attempt    installationAttempt
	startup    config.Startup
	backupInfo os.FileInfo
}

func digestBytes(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func readInstallation(startup config.Startup) (string, installationAttempt, []byte, error) {
	root := filepath.Dir(filepath.Clean(startup.DataDir))
	name := filepath.Join(root, installationJournal)
	if _, err := os.Lstat(name); errors.Is(err, os.ErrNotExist) {
		// Fresh/manual installations have no cutover journal. An existing or
		// malformed journal can never opt back into this compatibility path.
		return root, installationAttempt{}, nil, nil
	} else if err != nil {
		return "", installationAttempt{}, nil, ErrActivation
	}

	raw, err := files.ReadRegular(name, installationLimit)
	object, decodeErr := contracts.DecodeObject(raw, installationLimit)
	allowed := map[string]bool{
		"schemaVersion":     true,
		"attemptId":         true,
		"source":            true,
		"sourceCommit":      true,
		"version":           true,
		"directory":         true,
		"phase":             true,
		"backup":            true,
		"backupBytes":       true,
		"backupModifiedNS":  true,
		"backupIdentity":    true,
		"backupSha256":      true,
		"preparationSha256": true,
		"maintenanceId":     true,
	}
	for key := range object {
		if !allowed[key] {
			return "", installationAttempt{}, nil, ErrActivation
		}
	}

	var attempt installationAttempt
	if err != nil || decodeErr != nil || json.Unmarshal(raw, &attempt) != nil ||
		attempt.SchemaVersion != installationSchema || !installUUID.MatchString(attempt.AttemptID) ||
		!installHash.MatchString(attempt.Source) || !installCommit.MatchString(attempt.SourceCommit) ||
		!installSource.MatchString(attempt.Directory) || attempt.Version == "" || len(attempt.Version) > installationVersionLimit ||
		(attempt.MaintenanceID != "" && !installUUID.MatchString(attempt.MaintenanceID)) {
		return "", installationAttempt{}, nil, ErrActivation
	}

	return root, attempt, raw, nil
}

func installationRoots(startup config.Startup, root string, attempt installationAttempt, allowApp bool) (string, error) {
	if !filepath.IsAbs(root) || startup.DataDir != filepath.Join(root, "data") ||
		startup.WorkspaceRoot != filepath.Join(root, "workspaces") ||
		startup.Home == "" || root != filepath.Join(startup.Home, "dant") {
		return "", ErrActivation
	}
	if _, err := files.OrdinaryDirectory(root, false); err != nil {
		return "", ErrActivation
	}

	target := filepath.Join(root, "releases", attempt.Directory)
	if _, err := files.OrdinaryDirectory(target, false); err != nil {
		return "", ErrActivation
	}
	if startup.Root == target {
		return target, nil
	}
	if !allowApp || startup.Root != filepath.Join(root, "app") {
		return "", ErrActivation
	}

	info, err := os.Lstat(startup.Root)
	link, readErr := os.Readlink(startup.Root)
	if err != nil || readErr != nil || info.Mode()&os.ModeSymlink == 0 || link != target {
		return "", ErrActivation
	}
	return target, nil
}

func verifyInstallationBundle(ctx context.Context, target string, attempt installationAttempt, version, source string) error {
	if attempt.Version != version || attempt.SourceCommit != source {
		return ErrActivation
	}

	_, canonical, err := computer.VerifyBundle(ctx, target, version, source)
	if err != nil || digestBytes(canonical) != attempt.Source {
		return ErrActivation
	}
	return nil
}

// checkWorkerActivation runs before NewWorker opens any persistent store. Early
// cutover phases remain non-startable even after systemd or the OS restarts.
func checkWorkerActivation(ctx context.Context, startup config.Startup, version, source string) (string, error) {
	root, attempt, journal, err := readInstallation(startup)
	if err != nil || journal == nil {
		return startup.Root, err
	}
	if attempt.Phase != contracts.WorkerInstallationPhaseActivating && attempt.Phase != contracts.WorkerInstallationPhaseCommitted {
		return "", ErrActivation
	}

	target, err := installationRoots(startup, root, attempt, true)
	if err != nil || verifyInstallationBundle(ctx, target, attempt, version, source) != nil {
		return "", ErrActivation
	}

	raw, err := files.ReadRegular(filepath.Join(root, preparationFile), installationLimit)
	object, decodeErr := contracts.DecodeObject(raw, installationLimit)
	var receipt preparationReceipt
	if err != nil || decodeErr != nil || len(object) != preparationFieldCount || json.Unmarshal(raw, &receipt) != nil ||
		!installHash.MatchString(attempt.PreparationSHA256) || digestBytes(raw) != attempt.PreparationSHA256 ||
		!receipt.matches(attempt, startup) {
		return "", ErrActivation
	}

	backup := filepath.Join(root, "installation-backups", receipt.Backup)
	if _, err := os.Lstat(backup); err == nil {
		if _, err := backupObservation(backup, receipt.BackupBytes, receipt.BackupModifiedNS, receipt.BackupIdentity); err != nil {
			return "", ErrActivation
		}
	} else if !errors.Is(err, os.ErrNotExist) || attempt.Phase != contracts.WorkerInstallationPhaseCommitted {
		return "", ErrActivation
	}

	current, err := files.ReadRegular(filepath.Join(root, installationJournal), installationLimit)
	currentTarget, rootsErr := installationRoots(startup, root, attempt, true)
	if err != nil || rootsErr != nil || currentTarget != target || digestBytes(current) != digestBytes(journal) {
		return "", ErrActivation
	}

	return target, nil
}

func (receipt preparationReceipt) matches(attempt installationAttempt, startup config.Startup) bool {
	return receipt.SchemaVersion == installationSchema && receipt.AttemptID == attempt.AttemptID &&
		receipt.Source == attempt.Source && receipt.SourceCommit == attempt.SourceCommit &&
		receipt.Version == attempt.Version && receipt.Directory == attempt.Directory &&
		receipt.DataDir == startup.DataDir && receipt.WorkspaceRoot == startup.WorkspaceRoot &&
		validBackupName(receipt.Backup) && receipt.Backup == attempt.Backup &&
		receipt.BackupBytes > 0 && receipt.BackupBytes <= backups.ArchiveLimit && receipt.BackupBytes == attempt.BackupBytes &&
		receipt.BackupModifiedNS == attempt.BackupModifiedNS && receipt.BackupIdentity != "" &&
		receipt.BackupIdentity == attempt.BackupIdentity && installHash.MatchString(receipt.BackupSHA256) &&
		receipt.BackupSHA256 == attempt.BackupSHA256
}

func validBackupName(value string) bool {
	return len(value) == 40 && filepath.Ext(value) == ".raw" && installUUID.MatchString(value[:36])
}

// Only bounded metadata is checked at boot; preparation authenticated the whole
// archive. The committed receipt survives normal backup retention.
func backupObservation(name string, size int64, modified, identity string) (os.FileInfo, error) {
	if !installTime.MatchString(modified) || !installFileID.MatchString(identity) || size <= 0 || size > backups.ArchiveLimit {
		return nil, ErrActivation
	}

	managed, err := files.OpenManagedRoot(filepath.Dir(name), false)
	if err != nil {
		return nil, ErrActivation
	}
	defer managed.Close()

	ordinary, err := managed.OrdinaryFile(filepath.Base(name))
	if err != nil || !ordinary {
		return nil, ErrActivation
	}

	before, err := os.Lstat(name)
	if err != nil {
		return nil, ErrActivation
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, ErrActivation
	}
	defer file.Close()

	opened, err := file.Stat()
	fileID, identityErr := preparationFileIdentity(file)
	after, pathErr := os.Lstat(name)
	if err != nil || identityErr != nil || pathErr != nil || !os.SameFile(before, opened) ||
		!os.SameFile(opened, after) || !files.SingleLink(file) || !managed.Unchanged() ||
		opened.Size() != size || after.Size() != size ||
		strconv.FormatInt(opened.ModTime().UnixNano(), 10) != modified || !after.ModTime().Equal(opened.ModTime()) ||
		(identity != "" && fileID != identity) {
		return nil, ErrActivation
	}

	return opened, nil
}
