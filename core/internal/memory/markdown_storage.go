package memory

import (
	"context"
	"io"
	"io/fs"
	"os"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

type markdownReader interface {
	io.ReadCloser
	Stat() (fs.FileInfo, error)
}

type markdownBackupWriter interface {
	io.WriteCloser
	Sync() error
}

// Markdown snapshots use these feature-owned file capabilities. SQLite and
// the Store identity guards retain their separate authoritative boundaries.
type markdownStorage struct {
	lstat       func(string) (fs.FileInfo, error)
	open        func(string) (markdownReader, error)
	create      func(string) (markdownBackupWriter, error)
	mkdir       func(string, fs.FileMode) error
	writeAtomic func(context.Context, string, []byte, fs.FileMode) error
}

func diskMarkdownStorage() markdownStorage {
	return markdownStorage{
		lstat: os.Lstat,
		open: func(path string) (markdownReader, error) {
			return os.Open(path)
		},
		create: func(path string) (markdownBackupWriter, error) {
			return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		},
		mkdir:       os.Mkdir,
		writeAtomic: files.WriteAtomic,
	}
}
