package memory

import (
	"context"
	"io"
	"io/fs"
	"os"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

type snapshotReader interface {
	io.ReadCloser
	Stat() (fs.FileInfo, error)
}

type snapshotWriter interface {
	io.WriteCloser
	Sync() error
}

// Markdown and JSON snapshots use these feature-owned file capabilities.
// SQLite and the Store identity guards retain separate authoritative boundaries.
type snapshotStorage struct {
	lstat       func(string) (fs.FileInfo, error)
	open        func(string) (snapshotReader, error)
	create      func(string) (snapshotWriter, error)
	mkdir       func(string, fs.FileMode) error
	writeAtomic func(context.Context, string, []byte, fs.FileMode) error
}

func diskSnapshotStorage() snapshotStorage {
	return snapshotStorage{
		lstat: os.Lstat,
		open: func(path string) (snapshotReader, error) {
			return os.Open(path)
		},
		create: func(path string) (snapshotWriter, error) {
			return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		},
		mkdir:       os.Mkdir,
		writeAtomic: files.WriteAtomic,
	}
}

func (s *Store) writeBackupSnapshot(name string, data []byte) error {
	file, err := s.snapshots.create(name)
	if err != nil {
		return err
	}

	written, err := file.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
