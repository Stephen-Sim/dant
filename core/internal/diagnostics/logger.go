// Package diagnostics persists only bounded operational metadata. Its single
// writer is independent of HTTP and Engine locks, so log IO cannot stall input.
package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
)

const (
	Schema             = "dant.diagnostics.v1"
	StartupSchema      = "dant.startup.v1"
	MaxLineBytes       = 4096
	MaxFileBytes       = 5 * 1024 * 1024
	MaxTotalBytes      = 50 * 1024 * 1024
	MaxDirectoryFiles  = 4096
	MaxQueue           = 256
	MaxRecentRecords   = 200
	MaxRecentFileBytes = 256 * 1024
	Retention          = 3 * 24 * time.Hour
	CleanupInterval    = time.Hour
	StartupLogBytes    = 1024 * 1024
	maxSafeInteger     = 9007199254740991
)

var logName = regexp.MustCompile(`^dant-diagnostics-v1-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$`)

type Options struct {
	DataDir       string
	Role          string
	Version       string
	Now           func() time.Time
	MaxFileBytes  int64
	MaxTotalBytes int64
	Retention     time.Duration
}

type Record struct {
	At    string `json:"at"`
	Event string `json:"event"`
	Fields
}

type Status struct {
	Directory          string   `json:"directory"`
	Role               string   `json:"role"`
	Version            *string  `json:"version"`
	RetentionDays      float64  `json:"retentionDays"`
	MaxFileBytes       int64    `json:"maxFileBytes"`
	MaxTotalBytes      int64    `json:"maxTotalBytes"`
	CleanupIntervalMS  int64    `json:"cleanupIntervalMs"`
	StartupLogMaxBytes int64    `json:"startupLogMaxBytes"`
	FileCount          int      `json:"fileCount"`
	TotalBytes         int64    `json:"totalBytes"`
	LastCleanupAt      *float64 `json:"lastCleanupAt"`
	LastError          *string  `json:"lastError"`
	LastErrorAt        *float64 `json:"lastErrorAt"`
	DroppedRecords     uint64   `json:"droppedRecords"`
	Closed             bool     `json:"closed"`
}

type header struct {
	Schema    string `json:"schema"`
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
}

type retainedFile struct {
	name    string
	created time.Time
	size    int64
	info    fs.FileInfo
}

type Logger struct {
	ctx        context.Context
	options    Options
	queue      chan []byte
	fileGate   chan struct{}
	stop       chan struct{}
	done       chan struct{}
	mu         sync.Mutex
	status     Status
	current    string
	retained   []retainedFile
	cacheReady bool
	nextExpiry time.Time
}

func New(ctx context.Context, options Options) (*Logger, error) {
	if !filepath.IsAbs(options.DataDir) || strings.ContainsRune(options.DataDir, 0) {
		return nil, files.ErrManagedPath
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if !safeString(options.Role, token) {
		options.Role = "service"
	}
	if options.MaxTotalBytes < 256 || options.MaxTotalBytes > MaxTotalBytes {
		options.MaxTotalBytes = MaxTotalBytes
	}
	if options.MaxFileBytes < 256 || options.MaxFileBytes > MaxFileBytes {
		options.MaxFileBytes = MaxFileBytes
	}
	options.MaxFileBytes = min(options.MaxFileBytes, options.MaxTotalBytes)
	if options.Retention <= 0 || options.Retention > Retention {
		options.Retention = Retention
	}

	status := Status{
		Directory:          filepath.Join(options.DataDir, "logs"),
		Role:               options.Role,
		RetentionDays:      options.Retention.Hours() / 24,
		MaxFileBytes:       options.MaxFileBytes,
		MaxTotalBytes:      options.MaxTotalBytes,
		CleanupIntervalMS:  CleanupInterval.Milliseconds(),
		StartupLogMaxBytes: StartupLogBytes,
	}
	if validVersion(options.Version) {
		version := options.Version
		status.Version = &version
	}
	logger := &Logger{
		ctx: ctx, options: options, status: status,
		queue: make(chan []byte, MaxQueue), stop: make(chan struct{}), done: make(chan struct{}),
		fileGate: make(chan struct{}, 1),
	}

	if _, err := logger.cleanup(); err != nil {
		logger.failure("LOG_CLEANUP_FAILED")
	}
	go logger.run()
	return logger, nil
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func (logger *Logger) clock() time.Time {
	value := logger.options.Now()
	if value.IsZero() || value.UnixMilli() <= 0 {
		return time.Now()
	}
	return value
}

func (logger *Logger) failure(code string) {
	at := float64(logger.clock().UnixMilli())
	logger.mu.Lock()
	logger.status.LastError = &code
	logger.status.LastErrorAt = &at
	logger.mu.Unlock()
}

func (logger *Logger) Log(event string, fields Fields) bool {
	if !safeString(event, eventPattern) {
		logger.failure("LOG_INVALID_EVENT")
		return false
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		logger.failure("LOG_INVALID_METADATA")
		return false
	}
	object, err := contracts.DecodeObject(encoded, MaxLineBytes)
	if err != nil {
		logger.failure("LOG_RECORD_TOO_LARGE")
		return false
	}
	object = metadata(object)
	object["at"], _ = json.Marshal(iso(logger.clock()))
	object["event"], _ = json.Marshal(event)
	object["role"], _ = json.Marshal(logger.options.Role)
	if validVersion(logger.options.Version) {
		object["version"], _ = json.Marshal(logger.options.Version)
	}
	line, err := json.Marshal(object)
	if err != nil || len(line)+1 > MaxLineBytes {
		logger.failure("LOG_RECORD_TOO_LARGE")
		return false
	}
	line = append(line, '\n')

	logger.mu.Lock()
	defer logger.mu.Unlock()
	if logger.status.Closed || logger.ctx.Err() != nil {
		return false
	}
	select {
	case logger.queue <- line:
		return true
	default:
		logger.status.DroppedRecords++
		return false
	}
}

func (logger *Logger) run() {
	defer close(logger.done)
	timer := time.NewTicker(CleanupInterval)
	defer timer.Stop()

	write := func(line []byte) {
		if err := logger.acquireFiles(logger.ctx); err != nil {
			return
		}
		defer logger.releaseFiles()

		if err := logger.append(line); err != nil {
			logger.current = ""
			logger.cacheReady = false
			logger.failure("LOG_WRITE_FAILED")
		}
	}
	for {
		select {
		case line := <-logger.queue:
			write(line)
		case <-timer.C:
			if err := logger.acquireFiles(logger.ctx); err != nil {
				return
			}
			if _, err := logger.cleanup(); err != nil {
				logger.failure("LOG_CLEANUP_FAILED")
			}
			logger.releaseFiles()
		case <-logger.stop:
			for {
				select {
				case line := <-logger.queue:
					write(line)
				default:
					return
				}
			}
		case <-logger.ctx.Done():
			return
		}
	}
}

// The writer and read-only snapshots share file ownership, independently of the
// enqueue/status mutex. Our own append or rotation must not invalidate a read.
func (logger *Logger) acquireFiles(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case logger.fileGate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (logger *Logger) releaseFiles() {
	<-logger.fileGate
}

func (logger *Logger) scan(ctx context.Context, create bool) ([]retainedFile, error) {
	root, err := files.OpenManagedRoot(logger.status.Directory, create)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	entries, err := root.ReadDirectory(".")
	if err != nil {
		return nil, err
	}
	if len(entries) > MaxDirectoryFiles {
		return nil, files.ErrFileLimit
	}

	result := []retainedFile{}
	for _, entry := range entries {
		match := logName.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		data, info, err := root.ReadFileInfo(ctx, entry.Name(), MaxFileBytes)
		if err != nil {
			return nil, err
		}
		line, _, ok := strings.Cut(string(data[:min(len(data), 512)]), "\n")
		var value header
		if !ok || json.Unmarshal([]byte(line), &value) != nil || value.Schema != Schema || value.ID != match[2] {
			continue
		}
		created, err := time.Parse(time.RFC3339Nano, value.CreatedAt)
		if err != nil || iso(created) != value.CreatedAt || !strings.HasPrefix(value.CreatedAt, match[1]) {
			continue
		}
		result = append(result, retainedFile{name: entry.Name(), created: created, size: int64(len(data)), info: info})
	}
	slices.SortFunc(result, func(a, b retainedFile) int {
		if comparison := a.created.Compare(b.created); comparison != 0 {
			return comparison
		}
		return strings.Compare(a.name, b.name)
	})
	return result, nil
}

func (logger *Logger) remove(item retainedFile) error {
	if _, err := files.OrdinaryDirectory(logger.status.Directory, false); err != nil {
		return err
	}
	name := filepath.Join(logger.status.Directory, item.name)
	current, err := os.Lstat(name)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(item.info, current) {
		return files.ErrFileChanged
	}
	if err := os.Remove(name); err != nil {
		return err
	}
	if logger.current == item.name {
		logger.current = ""
	}
	return nil
}

func (logger *Logger) adoptStartup() error {
	root, err := files.OpenManagedRoot(logger.options.DataDir, false)
	if err != nil {
		return err
	}
	defer root.Close()

	data, err := root.ReadFile(logger.ctx, "startup.log", StartupLogBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil && !errors.Is(err, files.ErrFileLimit) {
		return err
	}
	line, _, _ := strings.Cut(string(data), "\n")
	var marker struct {
		Schema    string `json:"schema"`
		CreatedAt string `json:"createdAt"`
	}
	_ = json.Unmarshal([]byte(line), &marker)
	created, parseErr := time.Parse(time.RFC3339Nano, marker.CreatedAt)
	if err == nil && parseErr == nil && marker.Schema == StartupSchema &&
		iso(created) == marker.CreatedAt && !created.After(logger.clock()) && logger.clock().Sub(created) < logger.options.Retention {
		return nil
	}
	// Only a schema marker is retained; arbitrary old process output is discarded.
	encoded, _ := json.Marshal(struct {
		Schema    string `json:"schema"`
		CreatedAt string `json:"createdAt"`
	}{StartupSchema, iso(logger.clock())})
	return root.ResetLog(logger.ctx, "startup.log", append(encoded, '\n'))
}

func (logger *Logger) cleanup() ([]retainedFile, error) {
	logger.cacheReady = false
	items, err := logger.scan(logger.ctx, true)
	if err != nil {
		return nil, err
	}
	retained := make([]retainedFile, 0, len(items))
	var total int64
	for _, item := range items {
		if logger.clock().Sub(item.created) >= logger.options.Retention {
			if err := logger.remove(item); err != nil {
				return nil, err
			}
			continue
		}
		retained = append(retained, item)
		total += item.size
	}
	for total > logger.options.MaxTotalBytes && len(retained) > 0 {
		if err := logger.remove(retained[0]); err != nil {
			return nil, err
		}
		total -= retained[0].size
		retained = retained[1:]
	}
	if err := logger.adoptStartup(); err != nil {
		return nil, err
	}

	at := float64(logger.clock().UnixMilli())
	logger.mu.Lock()
	logger.status.TotalBytes, logger.status.FileCount = total, len(retained)
	logger.status.LastCleanupAt = &at
	logger.mu.Unlock()

	logger.retained = retained
	logger.cacheReady = true
	logger.nextExpiry = time.Time{}
	for _, item := range retained {
		expiry := item.created.Add(logger.options.Retention)
		if logger.nextExpiry.IsZero() || expiry.Before(logger.nextExpiry) {
			logger.nextExpiry = expiry
		}
	}
	return retained, nil
}

func (logger *Logger) append(line []byte) error {
	if !logger.cacheReady || !logger.nextExpiry.IsZero() && !logger.clock().Before(logger.nextExpiry) {
		if _, err := logger.cleanup(); err != nil {
			return err
		}
	}
	items := append([]retainedFile(nil), logger.retained...)
	var active *retainedFile
	var total int64
	for index := range items {
		item := &items[index]
		total += item.size
		if item.name == logger.current {
			active = item
		}
	}
	newFile := active == nil ||
		!strings.HasPrefix(active.name, "dant-diagnostics-v1-"+iso(logger.clock())[:10]) ||
		active.size+int64(len(line)) > logger.options.MaxFileBytes
	var contents []byte
	if newFile {
		id, err := uuid.NewRandom()
		if err != nil {
			return err
		}
		logger.current = "dant-diagnostics-v1-" + iso(logger.clock())[:10] + "-" + id.String() + ".jsonl"
		encoded, _ := json.Marshal(header{Schema: Schema, ID: id.String(), CreatedAt: iso(logger.clock())})
		contents = append(append(encoded, '\n'), line...)
	} else {
		contents = line
	}
	if int64(len(contents)) > logger.options.MaxFileBytes {
		return files.ErrFileLimit
	}
	for _, item := range items {
		if total+int64(len(contents)) <= logger.options.MaxTotalBytes {
			break
		}
		if !newFile && item.name == logger.current {
			continue
		}
		if err := logger.remove(item); err != nil {
			return err
		}
		total -= item.size
		logger.retained = slices.DeleteFunc(logger.retained, func(candidate retainedFile) bool { return candidate.name == item.name })
	}
	if total+int64(len(contents)) > logger.options.MaxTotalBytes {
		return files.ErrFileLimit
	}

	if newFile {
		name := filepath.Join(logger.status.Directory, logger.current)
		if _, err := os.Lstat(name); !errors.Is(err, fs.ErrNotExist) {
			return files.ErrFileChanged
		}
		if err := files.WriteAtomic(logger.ctx, name, contents, 0o600); err != nil {
			return err
		}
		info, err := files.CaptureIdentity(name)
		if err != nil {
			return err
		}
		created := logger.clock()
		logger.retained = append(logger.retained, retainedFile{name: logger.current, created: created, size: int64(len(contents)), info: info})
		expiry := created.Add(logger.options.Retention)
		if logger.nextExpiry.IsZero() || expiry.Before(logger.nextExpiry) {
			logger.nextExpiry = expiry
		}
	} else {
		actual, err := os.Lstat(filepath.Join(logger.status.Directory, logger.current))
		if err != nil || !os.SameFile(active.info, actual) || active.size != actual.Size() {
			logger.cacheReady = false
			return files.ErrFileChanged
		}
		root, err := files.OpenManagedRoot(logger.status.Directory, false)
		if err != nil {
			return err
		}
		for index := range logger.retained {
			if logger.retained[index].name == logger.current {
				logger.retained[index].size += int64(len(contents))
			}
		}
		err = root.AppendFile(logger.ctx, logger.current, contents, logger.options.MaxFileBytes)
		_ = root.Close()
		if err != nil {
			return err
		}
	}

	logger.mu.Lock()
	logger.status.TotalBytes = total + int64(len(contents))
	logger.status.FileCount = len(logger.retained)
	logger.mu.Unlock()
	return nil
}

func (logger *Logger) Status() Status {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	result := logger.status
	if result.Version != nil {
		value := *result.Version
		result.Version = &value
	}
	if result.LastError != nil {
		value := *result.LastError
		result.LastError = &value
	}
	if result.LastErrorAt != nil {
		value := *result.LastErrorAt
		result.LastErrorAt = &value
	}
	if result.LastCleanupAt != nil {
		value := *result.LastCleanupAt
		result.LastCleanupAt = &value
	}
	return result
}

func (logger *Logger) Recent(ctx context.Context, limit int) ([]Record, error) {
	limit = max(0, min(limit, MaxRecentRecords))
	result := []Record{}
	if limit == 0 {
		return result, nil
	}
	if err := logger.acquireFiles(ctx); err != nil {
		return nil, err
	}
	defer logger.releaseFiles()

	// Recent reads only validated files and fields. It never cleans up or writes.
	items, err := logger.scan(ctx, false)
	if err != nil {
		return nil, err
	}
	budget := StartupLogBytes
	for index := len(items) - 1; index >= 0 && budget > 0; index-- {
		data, err := files.ReadRegular(filepath.Join(logger.status.Directory, items[index].name), MaxFileBytes)
		if err != nil {
			return nil, err
		}
		length := min(len(data), min(MaxRecentFileBytes, budget))
		start := len(data) - length
		content := string(data[start:])
		budget -= length
		if start > 0 {
			_, content, _ = strings.Cut(content, "\n")
		}
		for _, line := range strings.Split(content, "\n") {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			object, err := contracts.DecodeObject([]byte(line), MaxLineBytes)
			if err != nil {
				continue
			}
			var event, at string
			if json.Unmarshal(object["event"], &event) != nil || !safeString(event, eventPattern) || json.Unmarshal(object["at"], &at) != nil {
				continue
			}
			created, err := time.Parse(time.RFC3339Nano, at)
			if err != nil || logger.clock().Sub(created) >= logger.options.Retention {
				continue
			}
			clean := metadata(object)
			encoded, _ := json.Marshal(clean)
			var fields Fields
			if json.Unmarshal(encoded, &fields) != nil {
				continue
			}
			result = append(result, Record{At: iso(created), Event: event, Fields: fields})
		}
	}
	slices.SortStableFunc(result, func(a, b Record) int { return strings.Compare(a.At, b.At) })
	if len(result) > limit {
		result = result[len(result)-limit:]
	}
	return result, nil
}

func (logger *Logger) Close() error {
	logger.mu.Lock()
	if !logger.status.Closed {
		logger.status.Closed = true
		close(logger.stop)
	}
	logger.mu.Unlock()
	<-logger.done
	return nil
}
