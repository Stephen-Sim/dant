//go:build !windows

package memory

import (
	"io/fs"
	"os"
	"syscall"
)

func isLinked(info fs.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
func oneLink(path string, info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
