package files

import (
	"context"
	"io"
	"io/fs"
	"os"
)

// Log writes retain the real opened handle for native identity checks. The
// caller owns path validation, open flags, bounds and the handle's lifetime.
type logFile interface {
	Stat() (fs.FileInfo, error)
	Fd() uintptr
	Write([]byte) (int, error)
	WriteAt([]byte, int64) (int, error)
	Truncate(int64) error
}

type logWrite struct {
	file      logFile
	before    fs.FileInfo
	current   func() (fs.FileInfo, error)
	unchanged func() bool
}

func (write logWrite) opened() (fs.FileInfo, error) {
	opened, err := write.file.Stat()
	if err != nil || !sameFile(write.before, opened) ||
		!openedSingleLink(write.file, opened) || !write.unchanged() {
		return nil, ErrFileChanged
	}
	return opened, nil
}

func (write logWrite) append(ctx context.Context, data []byte) error {
	opened, err := write.opened()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	count, err := write.file.Write(data)
	if err != nil {
		return err
	}
	if count != len(data) {
		return io.ErrShortWrite
	}

	after, err := write.file.Stat()
	current, pathErr := write.current()
	if err != nil || pathErr != nil || after.Size() != opened.Size()+int64(count) ||
		!os.SameFile(opened, after) || !os.SameFile(opened, current) ||
		!openedSingleLink(write.file, after) || !write.unchanged() {
		return ErrFileChanged
	}
	return nil
}

func (write logWrite) reset(ctx context.Context, data []byte) error {
	opened, err := write.opened()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := write.file.Truncate(0); err != nil {
		return err
	}
	count, err := write.file.WriteAt(data, 0)
	if err != nil {
		return err
	}
	if count != len(data) {
		return io.ErrShortWrite
	}
	after, err := write.file.Stat()
	current, pathErr := write.current()
	if err != nil || pathErr != nil || after.Size() != int64(count) ||
		!os.SameFile(opened, after) || !os.SameFile(opened, current) ||
		!openedSingleLink(write.file, after) || !write.unchanged() {
		return ErrFileChanged
	}
	return nil
}
