package files

import (
	"context"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const (
	RenameAttempts = 6
	RenameDelay    = 20 * time.Millisecond
)

// Atomic writes need a staged file and one bounded rename operation. The
// capabilities stay private; validation and identity checks are shared with
// every production caller and cannot be configured away.
type atomicWriteFile interface {
	Name() string
	Stat() (fs.FileInfo, error)
	Chmod(fs.FileMode) error
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

type atomicWriteIO struct {
	createTemp func(string, string) (atomicWriteFile, error)
	capture    func(string) (fs.FileInfo, error)
	rename     func(string, string) error
	wait       func(context.Context, int) error
}

func newAtomicWriteIO() atomicWriteIO {
	return atomicWriteIO{
		createTemp: func(directory, pattern string) (atomicWriteFile, error) {
			return os.CreateTemp(directory, pattern)
		},
		capture: CaptureIdentity,
		rename:  os.Rename,
		wait:    renameWait,
	}
}

// WriteAtomic keeps the old destination intact on pre-commit failure. Only a
// confirmed Windows lock error is retried, with unchanged source/target/parent.
func WriteAtomic(ctx context.Context, name string, data []byte, mode fs.FileMode) error {
	return writeAtomic(ctx, name, data, mode, newAtomicWriteIO())
}

func writeAtomic(ctx context.Context, name string, data []byte, mode fs.FileMode, operations atomicWriteIO) error {
	if !filepath.IsAbs(name) || ctx.Err() != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
		return ErrManagedPath
	}
	directory, err := OrdinaryDirectory(filepath.Dir(name), true)
	if err != nil {
		return err
	}
	parent, err := operations.capture(directory)
	if err != nil {
		return err
	}
	original, err := optionalIdentity(name)
	if err != nil {
		return err
	}
	temporary, err := operations.createTemp(directory, ".dant-write-*")
	if err != nil {
		return err
	}
	source := temporary.Name()
	createdInfo, err := temporary.Stat()
	if err != nil {
		temporary.Close()
		return err
	}
	defer func() {
		if current, err := os.Lstat(source); err == nil && os.SameFile(createdInfo, current) {
			_ = os.Remove(source)
		}
	}()
	if err = temporary.Chmod(mode); err == nil {
		var count int
		count, err = temporary.Write(data)
		if err == nil && count != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	sourceInfo, err := operations.capture(source)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < RenameAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		currentParent, parentErr := os.Lstat(directory)
		if parentErr != nil || !os.SameFile(parent, currentParent) || !unchanged(name, original) || !unchanged(source, sourceInfo) {
			return ErrFileChanged
		}
		if err = operations.rename(source, name); err == nil {
			return nil
		}
		if !retryableRename(err) || attempt+1 == RenameAttempts {
			return err
		}
		if err = operations.wait(ctx, attempt); err != nil {
			return err
		}
	}
	return err
}

func renameWait(ctx context.Context, attempt int) error {
	timer := time.NewTimer(RenameDelay * time.Duration(attempt+1))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
