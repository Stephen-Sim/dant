//go:build !windows

package schedules

import (
	"io/fs"
	"os"
	"syscall"
)

func linked(info fs.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
func singleLink(_ string, info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
