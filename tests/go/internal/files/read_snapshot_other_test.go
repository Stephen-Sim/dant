//go:build !windows

package files

import "os"

func openReadSnapshotFixture(name string) (*os.File, error) {
	return os.OpenFile(name, os.O_RDWR, 0)
}
