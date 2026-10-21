package backups

import (
	"os"

	"golang.org/x/sys/windows"
)

func sparsePreflightFixture(file *os.File, size int64) error {
	var returned uint32
	if err := windows.DeviceIoControl(windows.Handle(file.Fd()), windows.FSCTL_SET_SPARSE, nil, 0, nil, 0, &returned, nil); err != nil {
		return err
	}
	return file.Truncate(size)
}
