package legacyimport

import (
	"io/fs"
	"os"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

type publicationFile interface {
	Write([]byte) (int, error)
	Sync() error
	Stat() (fs.FileInfo, error)
	Close() error
	SingleLink() bool
}

type publicationHandle struct{ *os.File }

func (file publicationHandle) SingleLink() bool {
	return files.SingleLink(file.File)
}

func (target *destination) openExclusive(name string) (publicationFile, error) {
	file, err := target.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	return publicationHandle{file}, nil
}
