package backups

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const restoreJournalMaxBytes = 16 * 1024
const WorkerRestoreReceiptFile = ".dant-restore-receipt.json"

var ErrRestoreFailed = errors.New("restore_failed")
var restoreID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var identityNumber = regexp.MustCompile(`^[0-9]{1,40}$`)

type directoryID struct {
	Dev string `json:"dev"`
	Ino string `json:"ino"`
}

func (identity directoryID) valid() bool {
	return identityNumber.MatchString(identity.Dev) && identityNumber.MatchString(identity.Ino)
}

type RestoreOptions struct {
	DataDir       string
	WorkspaceRoot string
	RestoreID     string
	AssertOffline func(context.Context) error
	Rename        func(context.Context, string, string) error
}

type restorePaths struct {
	data              string
	workspace         string
	dataParent        string
	workspaceParent   string
	journal           string
	lock              string
	kernel            string
	rejection         string
	dataNew           string
	workspaceNew      string
	dataPrevious      string
	workspacePrevious string
	dataFailed        string
	workspaceFailed   string
}

func containsRoot(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && (relative == "." || (relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))))
}

func restoreLocations(options RestoreOptions) (restorePaths, error) {
	if !restoreID.MatchString(options.RestoreID) || !filepath.IsAbs(options.DataDir) || !filepath.IsAbs(options.WorkspaceRoot) {
		return restorePaths{}, ErrInvalid
	}
	data := filepath.Clean(options.DataDir)
	workspace := filepath.Clean(options.WorkspaceRoot)
	if filepath.Dir(data) == data || filepath.Dir(workspace) == workspace || containsRoot(data, workspace) || containsRoot(workspace, data) {
		return restorePaths{}, ErrInvalid
	}
	dataParent, err := files.OrdinaryDirectory(filepath.Dir(data), false)
	if err != nil {
		return restorePaths{}, ErrInvalid
	}
	workspaceParent, err := files.OrdinaryDirectory(filepath.Dir(workspace), false)
	if err != nil {
		return restorePaths{}, ErrInvalid
	}
	sum := sha256.Sum256([]byte(data + "\x00" + workspace))
	pair := hex.EncodeToString(sum[:])[:24]
	prefix := ".dant-restore-" + options.RestoreID
	return restorePaths{
		data:              data,
		workspace:         workspace,
		dataParent:        dataParent,
		workspaceParent:   workspaceParent,
		journal:           filepath.Join(dataParent, ".dant-restore-"+pair+".json"),
		lock:              filepath.Join(dataParent, ".dant-restore-"+pair+".lock"),
		kernel:            filepath.Join(dataParent, ".dant-restore-"+pair+".flock"),
		rejection:         filepath.Join(dataParent, ".dant-restore-"+pair+".rejected.json"),
		dataNew:           filepath.Join(dataParent, prefix+"-data.new"),
		workspaceNew:      filepath.Join(workspaceParent, prefix+"-workspace.new"),
		dataPrevious:      filepath.Join(dataParent, prefix+"-data.previous"),
		workspacePrevious: filepath.Join(workspaceParent, prefix+"-workspace.previous"),
		dataFailed:        filepath.Join(dataParent, prefix+"-data.failed"),
		workspaceFailed:   filepath.Join(workspaceParent, prefix+"-workspace.failed"),
	}, nil
}

func writeRestoreJSON(ctx context.Context, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > restoreJournalMaxBytes {
		return ErrRestoreFailed
	}

	if err := files.WriteAtomic(ctx, name, raw, 0600); err != nil {
		return ErrRestoreFailed
	}

	return syncDirectory(filepath.Dir(name))
}

func readRestoreJSON(name string, value any) error {
	raw, err := files.ReadRegular(name, restoreJournalMaxBytes)
	if err != nil {
		return err
	}

	if _, err := contracts.DecodeObject(raw, restoreJournalMaxBytes); err != nil {
		return ErrRestoreFailed
	}

	if json.Unmarshal(raw, value) != nil {
		return ErrRestoreFailed
	}

	return nil
}

func restoreRename(ctx context.Context, options RestoreOptions, from, to string) error {
	operation := options.Rename
	if operation == nil {
		operation = files.RenameManaged
	}

	if err := operation(ctx, from, to); err != nil {
		return err
	}

	if err := syncDirectory(filepath.Dir(from)); err != nil {
		return err
	}

	if filepath.Dir(from) != filepath.Dir(to) {
		return syncDirectory(filepath.Dir(to))
	}

	return nil
}

func removeRestoreDirectory(locations restorePaths, name string) error {
	allowed := false
	for _, candidate := range []string{locations.dataNew, locations.workspaceNew, locations.dataPrevious, locations.workspacePrevious, locations.dataFailed, locations.workspaceFailed} {
		if name == candidate {
			allowed = true
			break
		}
	}

	if !allowed || !filepath.IsAbs(name) {
		return ErrRestoreFailed
	}

	if _, err := files.OrdinaryDirectory(filepath.Dir(name), false); err != nil {
		return ErrRestoreFailed
	}
	stat, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
		return ErrRestoreFailed
	}

	return os.RemoveAll(name)
}

func withRestoreLock(ctx context.Context, options RestoreOptions, operation func(restorePaths) error) error {
	locations, err := restoreLocations(options)
	if err != nil {
		return err
	}
	parent, err := os.Lstat(locations.dataParent)
	if err != nil {
		return ErrRestoreFailed
	}
	kernel, err := os.OpenFile(locations.kernel, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return ErrRestoreFailed
	}
	defer kernel.Close()
	named, err := os.Lstat(locations.kernel)
	opened, openErr := kernel.Stat()
	if err != nil || openErr != nil || !named.Mode().IsRegular() || !os.SameFile(named, opened) || !stageSingleLink(kernel) {
		return ErrRestoreFailed
	}

	if err := kernelLock(kernel); err != nil {
		return err
	}
	current := func() bool {
		parentNow, err := os.Lstat(locations.dataParent)
		if err != nil || !parentNow.IsDir() || !os.SameFile(parent, parentNow) {
			return false
		}
		namedNow, err := os.Lstat(locations.kernel)
		return err == nil && namedNow.Mode().IsRegular() && os.SameFile(named, namedNow) && stageSingleLink(kernel)
	}

	if !current() {
		return ErrRestoreFailed
	}

	if raw, err := files.ReadRegular(locations.lock, restoreJournalMaxBytes); err == nil {
		var owner struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(raw, &owner) != nil || owner.PID <= 0 || owner.PID > 2147483647 {
			return ErrRestoreFailed
		}
		if processAlive(owner.PID) {
			return ErrBusy
		}
		if !current() {
			return ErrRestoreFailed
		}
		if err := os.Remove(locations.lock); err != nil {
			return ErrRestoreFailed
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrRestoreFailed
	}
	owner, err := os.OpenFile(locations.lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ErrBusy
	}
	identity, err := owner.Stat()
	if err != nil {
		owner.Close()
		return ErrRestoreFailed
	}
	defer func() {
		if current() {
			if info, err := os.Lstat(locations.lock); err == nil && info.Mode().IsRegular() && os.SameFile(identity, info) {
				_ = os.Remove(locations.lock)
			}
		}
	}()
	raw, _ := json.Marshal(struct {
		PID       int    `json:"pid"`
		RestoreID string `json:"restoreId"`
	}{os.Getpid(), options.RestoreID})
	if _, err := owner.Write(raw); err != nil {
		owner.Close()
		return ErrRestoreFailed
	}

	if owner.Sync() != nil {
		owner.Close()
		return ErrRestoreFailed
	}
	owner.Close()
	if err := ctx.Err(); err != nil {
		return err
	}

	return operation(locations)
}
