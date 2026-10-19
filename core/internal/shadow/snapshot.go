package shadow

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/transport"
	_ "modernc.org/sqlite"
)

const maxSnapshotPathBytes = 4096
const snapshotBusyTimeoutMilliseconds = 5000

var snapshotSidecars = [...]string{"-journal", "-wal", "-shm"}

type directoryIdentity struct {
	path string
	info fs.FileInfo
}
type snapshot struct {
	path    string
	file    *os.File
	info    fs.FileInfo
	parents []directoryIdentity
	db      *sql.DB
}

func ordinaryParents(file string) ([]directoryIdentity, error) {
	var parents []directoryIdentity
	for directory := filepath.Dir(file); ; directory = filepath.Dir(directory) {
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || linked(info) {
			return nil, transport.NewError(transport.InvalidSnapshot)
		}
		parents = append(parents, directoryIdentity{directory, info})
		if filepath.Dir(directory) == directory {
			break
		}
	}
	return parents, nil
}

func openSnapshot(ctx context.Context, file string) (*snapshot, error) {
	if len(file) == 0 || len(file) > maxSnapshotPathBytes || strings.ContainsRune(file, 0) || !filepath.IsAbs(file) || strings.HasPrefix(file, `\\`) {
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	file = filepath.Clean(file)
	parents, err := ordinaryParents(file)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || linked(info) || info.Size() <= 0 || info.Size() > contracts.CoreSnapshotMaxBytes {
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	handle, err := openSnapshotFile(file)
	if err != nil {
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	opened, err := handle.Stat()
	if err != nil || !os.SameFile(info, opened) || !singleLink(handle, opened) {
		handle.Close()
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	value := &snapshot{path: file, file: handle, info: opened, parents: parents}
	if err := value.unchanged(); err != nil {
		value.close()
		return nil, err
	}
	uriPath := filepath.ToSlash(file)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	parameters := url.Values{"mode": {"ro"}, "immutable": {"1"}, "_pragma": {"query_only(1)", "trusted_schema(0)", fmt.Sprintf("busy_timeout(%d)", snapshotBusyTimeoutMilliseconds)}}
	uri.RawQuery = parameters.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		value.close()
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	value.db = db
	db.SetMaxOpenConns(transport.Workers)
	db.SetMaxIdleConns(transport.Workers)
	if err := db.PingContext(ctx); err != nil {
		value.close()
		return nil, transport.NewError(transport.InvalidSnapshot)
	}
	if err := value.unchanged(); err != nil {
		value.close()
		return nil, err
	}
	return value, nil
}

func (value *snapshot) unchanged() error {
	for _, parent := range value.parents {
		current, err := os.Lstat(parent.path)
		if err != nil || !current.IsDir() || linked(current) || !os.SameFile(parent.info, current) {
			return transport.NewError(transport.InvalidSnapshot)
		}
	}
	for _, suffix := range snapshotSidecars {
		_, err := os.Lstat(value.path + suffix)
		if !os.IsNotExist(err) {
			return transport.NewError(transport.InvalidSnapshot)
		}
	}
	current, err := os.Lstat(value.path)
	if err != nil || !current.Mode().IsRegular() || linked(current) || !os.SameFile(value.info, current) || current.Size() != value.info.Size() || !current.ModTime().Equal(value.info.ModTime()) || current.Mode() != value.info.Mode() {
		return transport.NewError(transport.InvalidSnapshot)
	}
	held, err := value.file.Stat()
	if err != nil || !os.SameFile(value.info, held) || !singleLink(value.file, held) || held.Size() != value.info.Size() || !held.ModTime().Equal(value.info.ModTime()) {
		return transport.NewError(transport.InvalidSnapshot)
	}
	return nil
}

func (value *snapshot) close() {
	if value.db != nil {
		_ = value.db.Close()
	}
	if value.file != nil {
		_ = value.file.Close()
	}
}
