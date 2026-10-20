//go:build !windows

package backups

import "os"

func sparsePreflightFixture(file *os.File, size int64) error {
	return file.Truncate(size)
}
