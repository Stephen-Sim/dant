package backups

import (
	"os"
	"strconv"

	"golang.org/x/sys/windows"
)

func directoryIdentity(name string) (directoryID, error) {
	file, err := os.Open(name)
	if err != nil {
		return directoryID{}, ErrInvalid
	}
	defer file.Close()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info) != nil {
		return directoryID{}, ErrInvalid
	}

	return directoryID{Dev: strconv.FormatUint(uint64(info.VolumeSerialNumber), 10), Ino: strconv.FormatUint(uint64(info.FileIndexHigh)<<32|uint64(info.FileIndexLow), 10)}, nil
}

func kernelLock(file *os.File) error {
	var overlapped windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped); err != nil {
		return ErrBusy
	}

	return nil
}

func processAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err != windows.ERROR_INVALID_PARAMETER
	}
	defer windows.CloseHandle(handle)
	var exit uint32
	if windows.GetExitCodeProcess(handle, &exit) != nil {
		return true
	}

	return exit == 259
}

func syncDirectory(_ string) error { return nil }
