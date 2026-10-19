//go:build !windows

package shadow

import (
	"io/fs"
	"os"
	"syscall"
)

// Unix sharing cannot impose a mandatory write lock. The caller supplies a
// closed, private snapshot rather than a live database; identity guards remain
// a second check around every query.
func openSnapshotFile(path string) (*os.File, error) { return os.Open(path) }

func linked(info fs.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }

func singleLink(_ *os.File, info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
