//go:build !windows

package backups

import (
	"errors"
	"os"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

func directoryIdentity(name string) (directoryID, error) {
	stat, err := os.Lstat(name)
	if err != nil {
		return directoryID{}, ErrInvalid
	}
	value, ok := stat.Sys().(*syscall.Stat_t)
	if !ok {
		return directoryID{}, ErrInvalid
	}

	return directoryID{Dev: strconv.FormatUint(uint64(value.Dev), 10), Ino: strconv.FormatUint(uint64(value.Ino), 10)}, nil
}

func kernelLock(file *os.File) error {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return ErrBusy
	}

	return nil
}

func processAlive(pid int) bool { return !errors.Is(unix.Kill(pid, 0), unix.ESRCH) }
func syncDirectory(name string) error {
	file, err := os.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
