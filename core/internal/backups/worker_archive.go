package backups

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/files"
	_ "modernc.org/sqlite"
)

const sqliteConnectionLimit = 128
const sqliteMagic = "SQLite format 3\x00"

var firefoxPIDLock = regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}:\+[1-9][0-9]{0,9}$`)
var sqliteSidecars = [...]string{"-wal", "-shm", "-journal"}

type WorkerBackupOptions struct {
	DataDir         string
	WorkspaceRoot   string
	TemporaryRoot   string
	SourceID        string
	AppVersion      string
	ValidateCurrent func(context.Context) error
	Now             func() time.Time
}

type WorkerBackup struct {
	Archive ValidatedArchive
	close   func() error
}

func (backup *WorkerBackup) Close() error { return backup.close() }
func (backup *WorkerBackup) WriteTo(ctx context.Context, output io.Writer) error {
	return WriteArchive(ctx, output, backup.Archive)
}

type observedSource struct {
	name    string
	stat    os.FileInfo
	changed int64
	link    string
}

type capturedDatabase struct {
	db      *sql.DB
	version int64
}

type workerCapture struct {
	ctx                context.Context
	options            WorkerBackupOptions
	staging, workspace string
	entries            []ArchiveEntry
	observed           []observedSource
	databases          []capturedDatabase
	count              int
	bytes              int64
}

// CreateWorkerBackup captures bounded private files before exposing an archive.
// Only application-owned data databases are opened by SQLite. Workspace
// databases, including browser profiles and their sidecars, remain opaque bytes.
func CreateWorkerBackup(ctx context.Context, options WorkerBackupOptions) (*WorkerBackup, error) {
	if !filepath.IsAbs(options.DataDir) || !filepath.IsAbs(options.WorkspaceRoot) || !sourceIdentity.MatchString(options.SourceID) || !archiveVersion.MatchString(options.AppVersion) {
		return nil, ErrInvalid
	}
	data, err := files.OrdinaryDirectory(options.DataDir, false)
	if err != nil {
		return nil, ErrInvalid
	}
	workspace, err := files.OrdinaryDirectory(options.WorkspaceRoot, true)
	if err != nil || data == workspace || containsRoot(workspace, data) {
		return nil, ErrInvalid
	}

	if options.ValidateCurrent != nil {
		if err := options.ValidateCurrent(ctx); err != nil {
			return nil, err
		}
	}

	if _, err := ordinaryBackupFile(filepath.Join(data, "state.json")); err != nil {
		return nil, err
	}
	temporary := options.TemporaryRoot
	if temporary == "" {
		temporary = os.TempDir()
	}
	temporary, err = files.OrdinaryDirectory(temporary, false)
	if err != nil {
		return nil, ErrInvalid
	}
	staging, err := os.MkdirTemp(temporary, "dant-worker-backup-")
	if err != nil {
		return nil, ErrInvalid
	}
	_ = os.Chmod(staging, 0700)
	identity, err := os.Lstat(staging)
	if err != nil {
		return nil, ErrInvalid
	}
	var once sync.Once
	var cleanupError error
	cleanup := func() error {
		once.Do(func() {
			current, err := os.Lstat(staging)
			if errors.Is(err, os.ErrNotExist) {
				return
			}
			if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(identity, current) || filepath.Dir(staging) != temporary {
				cleanupError = ErrSourceChanged
				return
			}
			cleanupError = os.RemoveAll(staging)
		})
		return cleanupError
	}
	capture := workerCapture{ctx: ctx, options: options, staging: staging, workspace: workspace, entries: []ArchiveEntry{}}
	success := false
	defer func() {
		for _, database := range capture.databases {
			database.db.Close()
		}
		if !success {
			_ = cleanup()
		}
	}()
	for _, domain := range []struct{ name, source string }{{"data", data}, {"workspace", workspace}} {
		if os.Mkdir(filepath.Join(staging, domain.name), 0700) != nil {
			return nil, ErrInvalid
		}
		if err := capture.directory(domain.source, domain.name, ""); err != nil {
			return nil, err
		}
	}

	if options.ValidateCurrent != nil {
		if err := options.ValidateCurrent(ctx); err != nil {
			return nil, err
		}
	}

	if err := capture.validate(); err != nil {
		return nil, err
	}
	now := time.Now
	if options.Now != nil {
		now = options.Now
	}
	manifest := Manifest{SchemaVersion: 1, CreatedAt: now().UnixMilli(), AppVersion: options.AppVersion, SourceID: options.SourceID, Files: capture.count, Bytes: capture.bytes}
	if !manifest.Valid() {
		return nil, ErrInvalid
	}
	success = true
	return &WorkerBackup{Archive: ValidatedArchive{Manifest: manifest, Directory: staging, Entries: capture.entries}, close: cleanup}, nil
}

func ordinaryBackupFile(name string) (os.FileInfo, error) {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxFileBytes {
		return nil, ErrInvalid
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, ErrInvalid
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !stageSingleLink(file) {
		return nil, ErrInvalid
	}

	return info, nil
}

func sqliteFile(name string) (bool, error) {
	info, err := ordinaryBackupFile(name)
	if err != nil {
		return false, err
	}

	if info.Size() < int64(len(sqliteMagic)) {
		return false, nil
	}
	file, err := os.Open(name)
	if err != nil {
		return false, ErrInvalid
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !stageSingleLink(file) {
		return false, ErrSourceChanged
	}
	magic := make([]byte, len(sqliteMagic))
	if _, err := io.ReadFull(file, magic); err != nil {
		return false, ErrSourceChanged
	}

	return string(magic) == sqliteMagic, nil
}

func sourceVersion(name string, info os.FileInfo) (int64, error) {
	if info == nil {
		return 0, ErrSourceChanged
	}

	return fileChangeTime(name, info)
}

func (capture *workerCapture) observe(name string, info os.FileInfo, link string) error {
	if len(capture.observed) > MaxFiles*5 {
		return ErrSizeLimit
	}
	changed := int64(0)
	var err error
	if info != nil {
		changed, err = sourceVersion(name, info)
		if err != nil {
			return ErrSourceChanged
		}
	}
	capture.observed = append(capture.observed, observedSource{name, info, changed, link})
	return nil
}

func excludedBackupName(domain, prefix, name string) bool {
	switch name {
	case "node_modules", ".cache", ".ssh", ".codex", ".openai":
		return true
	}

	if domain == "data" && prefix == "" {
		switch name {
		case "runtime", "deploy", "diagnostics", "logs", "cache", "tmp", "updates", "backups", ".env", ".dant-core-owner.lock":
			return true
		}
	}

	return false
}

func (capture *workerCapture) directory(directory, domain, prefix string) error {
	if err := capture.ctx.Err(); err != nil {
		return err
	}
	before, err := os.Lstat(directory)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return ErrInvalid
	}

	if err := capture.observe(directory, before, ""); err != nil {
		return err
	}
	children, err := os.ReadDir(directory)
	if err != nil {
		return ErrInvalid
	}
	sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
	for _, child := range children {
		if err := capture.ctx.Err(); err != nil {
			return err
		}
		name := child.Name()
		relative := name
		if prefix != "" {
			relative = prefix + "/" + name
		}
		source := filepath.Join(directory, name)
		if excludedBackupName(domain, prefix, name) || (domain == "data" && containsRoot(capture.workspace, source)) || containsRoot(capture.staging, source) {
			continue
		}
		if !ValidArchivePath(relative) {
			return ErrInvalid
		}
		if domain == "data" {
			skip := false
			for _, suffix := range sqliteSidecars {
				if strings.HasSuffix(source, suffix) {
					main := strings.TrimSuffix(source, suffix)
					if _, err := os.Lstat(main); err == nil {
						database, err := sqliteFile(main)
						if err != nil {
							return err
						}
						skip = database
					}
					break
				}
			}
			if skip {
				continue
			}
		}
		info, err := os.Lstat(source)
		if err != nil {
			return ErrInvalid
		}
		target := filepath.Join(capture.staging, domain, filepath.FromSlash(relative))
		if domain == "workspace" && name == "lock" && info.Mode()&os.ModeSymlink != 0 {
			ok, err := capture.firefoxLock(directory, source, info)
			if err != nil {
				return err
			}
			if ok {
				continue
			}
		}
		if len(capture.entries) >= MaxFiles || info.Mode()&os.ModeSymlink != 0 {
			return ErrInvalid
		}
		if info.IsDir() {
			if os.Mkdir(target, 0700) != nil {
				return ErrInvalid
			}
			capture.entries = append(capture.entries, ArchiveEntry{Domain: domain, Path: relative, Directory: true})
			if err := capture.directory(source, domain, relative); err != nil {
				return err
			}
			continue
		}
		if _, err := ordinaryBackupFile(source); err != nil {
			return err
		}
		if err := capture.observe(source, info, ""); err != nil {
			return err
		}
		database := false
		if domain == "data" {
			database, err = sqliteFile(source)
			if err != nil {
				return err
			}
		}
		var hash string
		if database {
			if len(capture.databases) >= sqliteConnectionLimit {
				return ErrSizeLimit
			}
			for _, suffix := range sqliteSidecars {
				sidecar := source + suffix
				sidecarInfo, err := os.Lstat(sidecar)
				if err != nil && !errors.Is(err, os.ErrNotExist) {
					return ErrInvalid
				}
				if err == nil {
					if _, err := ordinaryBackupFile(sidecar); err != nil {
						return err
					}
				}
				if err := capture.observe(sidecar, sidecarInfo, ""); err != nil {
					return err
				}
			}
			db, version, err := snapshotDataSQLite(capture.ctx, source, target)
			if err != nil {
				return err
			}
			capture.databases = append(capture.databases, capturedDatabase{db, version})
			hash, err = hashBackupFile(capture.ctx, target)
			if err != nil {
				return err
			}
		} else {
			hash, err = copyStableBackupFile(capture.ctx, source, target)
			if err != nil {
				return err
			}
		}
		copied, err := ordinaryBackupFile(target)
		if err != nil {
			return err
		}
		capture.count++
		capture.bytes += copied.Size()
		if capture.count > MaxFiles || capture.bytes > MaxBackupBytes {
			return ErrSizeLimit
		}
		capture.entries = append(capture.entries, ArchiveEntry{Domain: domain, Path: relative, Size: copied.Size(), Executable: info.Mode()&0111 != 0, SHA256: hash})
	}

	return nil
}

func (capture *workerCapture) firefoxLock(directory, source string, info os.FileInfo) (bool, error) {
	target, err := os.Readlink(source)
	if err != nil || !firefoxPIDLock.MatchString(target) {
		return false, nil
	}
	markers := []observedSource{}
	for _, name := range []string{"prefs.js", "times.json", "compatibility.ini", "places.sqlite"} {
		file := filepath.Join(directory, name)
		stat, err := ordinaryBackupFile(file)
		if err != nil {
			return false, nil
		}
		changed, err := sourceVersion(file, stat)
		if err != nil {
			return false, nil
		}
		markers = append(markers, observedSource{name: file, stat: stat, changed: changed})
	}
	database, err := sqliteFile(filepath.Join(directory, "places.sqlite"))
	if err != nil || !database {
		return false, nil
	}

	if err := capture.observe(source, info, target); err != nil {
		return false, err
	}
	capture.observed = append(capture.observed, markers...)
	return true, nil
}

func (capture *workerCapture) validate() error {
	for _, source := range capture.observed {
		if err := capture.ctx.Err(); err != nil {
			return err
		}
		current, err := os.Lstat(source.name)
		if source.stat == nil {
			if !errors.Is(err, os.ErrNotExist) {
				return ErrSourceChanged
			}
			continue
		}
		if err != nil || !os.SameFile(source.stat, current) || source.stat.Size() != current.Size() || !source.stat.ModTime().Equal(current.ModTime()) {
			return ErrSourceChanged
		}
		changed, err := sourceVersion(source.name, current)
		if err != nil || changed != source.changed {
			return ErrSourceChanged
		}
		if source.link != "" {
			target, err := os.Readlink(source.name)
			if err != nil || target != source.link {
				return ErrSourceChanged
			}
		}
	}
	for _, database := range capture.databases {
		var version int64
		if database.db.QueryRowContext(capture.ctx, "PRAGMA data_version").Scan(&version) != nil || version != database.version {
			return ErrSourceChanged
		}
	}

	return nil
}

func snapshotDataSQLite(ctx context.Context, source, target string) (*sql.DB, int64, error) {
	uriPath := filepath.ToSlash(source)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{}
	query.Set("mode", "ro")
	query.Add("_pragma", "trusted_schema(0)")
	query.Add("_pragma", "busy_timeout(1000)")
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, 0, ErrInvalid
	}
	db.SetMaxOpenConns(1)
	success := false
	defer func() {
		if !success {
			db.Close()
		}
	}()
	var version int64
	if db.QueryRowContext(ctx, "PRAGMA data_version").Scan(&version) != nil {
		return nil, 0, ErrInvalid
	}
	var check string
	if db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check) != nil || check != "ok" {
		return nil, 0, ErrInvalid
	}

	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", target); err != nil {
		return nil, 0, ErrInvalid
	}

	if os.Chmod(target, 0600) != nil {
		return nil, 0, ErrInvalid
	}
	success = true
	return db, version, nil
}

func hashBackupFile(ctx context.Context, name string) (string, error) {
	file, err := os.Open(name)
	if err != nil {
		return "", ErrInvalid
	}
	defer file.Close()
	if !stageSingleLink(file) {
		return "", ErrInvalid
	}
	hash := sha256.New()
	if _, err := copyBounded(ctx, hash, file, MaxFileBytes); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

func copyStableBackupFile(ctx context.Context, source, target string) (string, error) {
	before, err := ordinaryBackupFile(source)
	if err != nil {
		return "", err
	}
	changed, err := sourceVersion(source, before)
	if err != nil {
		return "", ErrSourceChanged
	}
	input, err := os.Open(source)
	if err != nil {
		return "", ErrInvalid
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(before, opened) || !stageSingleLink(input) {
		return "", ErrSourceChanged
	}
	mode := os.FileMode(0600)
	if before.Mode()&0111 != 0 {
		mode = 0700
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return "", ErrInvalid
	}
	hash := sha256.New()
	written, err := copyBounded(ctx, io.MultiWriter(output, hash), input, before.Size())
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	after, statErr := ordinaryBackupFile(source)
	changedAfter, changeErr := sourceVersion(source, after)
	if err != nil || closeErr != nil || statErr != nil || changeErr != nil || written != before.Size() || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || changed != changedAfter || !stageSingleLink(input) {
		return "", ErrSourceChanged
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}
