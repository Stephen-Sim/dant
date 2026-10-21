//go:build !windows

package backups

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

type unixStageMap struct{ data []byte }

func (mapping *unixStageMap) Bytes() []byte { return mapping.data }
func (mapping *unixStageMap) Flush() error {
	if mapping.data == nil {
		return nil
	}

	return unix.Msync(mapping.data, unix.MS_SYNC)
}

func (mapping *unixStageMap) Close() error {
	if mapping.data == nil {
		return nil
	}
	err := unix.Munmap(mapping.data)
	mapping.data = nil
	return err
}

func mapStage(file *os.File, length int) (mappedStage, error) {
	data, err := unix.Mmap(int(file.Fd()), 0, length, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		return nil, err
	}

	return &unixStageMap{data: data}, nil
}

func stageSingleLink(file interface{ Stat() (os.FileInfo, error) }) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
