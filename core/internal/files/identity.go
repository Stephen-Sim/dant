package files

import (
	"io/fs"
	"os"
	"path/filepath"
)

// CaptureIdentity keeps the identity obtained from an opened handle. A path-only
// FileInfo can defer loading its Windows file ID until a later SameFile call,
// after that path has already been replaced.
func CaptureIdentity(name string) (fs.FileInfo, error) {
	return captureIdentity(name, os.Lstat, openIdentity)
}

type identityHandle interface {
	Stat() (fs.FileInfo, error)
	Close() error
}

func openIdentity(name string) (identityHandle, error) {
	return os.Open(name)
}

func captureIdentity(
	name string,
	lstat func(string) (fs.FileInfo, error),
	open func(string) (identityHandle, error),
) (fs.FileInfo, error) {
	if !filepath.IsAbs(name) {
		return nil, ErrManagedPath
	}
	before, err := lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() && !before.IsDir() {
		return nil, ErrManagedPath
	}
	file, err := open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	current, err := lstat(name)
	if err != nil || !os.SameFile(before, opened) || !os.SameFile(opened, current) || current.Mode()&fs.ModeSymlink != 0 {
		return nil, ErrFileChanged
	}
	if opened.Mode().IsRegular() && (!sameFile(before, opened) || !sameFile(opened, current)) {
		return nil, ErrFileChanged
	}
	return opened, nil
}
