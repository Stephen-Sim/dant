//go:build !windows

package files

import (
	"io/fs"
	"os"
	"syscall"
)

func singleLink(_ string, info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}

func openRegular(name string) (*os.File, error) {
	fd, err := syscall.Open(name, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !singleLink(name, info) {
		file.Close()
		return nil, ErrManagedPath
	}
	return file, nil
}

func retryableRename(error) bool { return false }

func openedSingleLink(_ interface{ Fd() uintptr }, info fs.FileInfo) bool {
	return singleLink("", info)
}
