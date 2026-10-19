//go:build !windows

package application

import (
	"fmt"
	"os"
	"syscall"
)

func preparationFileIdentity(file *os.File) (string, error) {
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", ErrActivation
	}
	return fmt.Sprintf("%x:%x", stat.Dev, stat.Ino), nil
}
