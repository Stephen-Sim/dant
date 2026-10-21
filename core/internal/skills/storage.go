package skills

import (
	"context"
	"io/fs"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

// Skills retains policy and transaction ownership while depending only on the
// managed filesystem operations it consumes. Each library owns its boundaries.
type skillRoot interface {
	ReadFile(context.Context, string, int64) ([]byte, error)
	ReadDirectory(string) ([]fs.DirEntry, error)
	Close() error
}

type libraryStorage struct {
	openRoot      func(string, bool) (skillRoot, error)
	writeAtomic   func(context.Context, string, []byte, fs.FileMode) error
	rename        func(context.Context, string, string) error
	removeStaging func(string, string) error
}

func diskLibraryStorage() libraryStorage {
	return libraryStorage{
		openRoot: func(directory string, create bool) (skillRoot, error) {
			return files.OpenManagedRoot(directory, create)
		},
		writeAtomic:   files.WriteAtomic,
		rename:        files.RenameManaged,
		removeStaging: removeStaging,
	}
}
