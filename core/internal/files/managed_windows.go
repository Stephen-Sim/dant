package files

import (
	"errors"
	"io/fs"
	"os"

	"golang.org/x/sys/windows"
)

func openRegular(name string) (*os.File, error) {
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, ErrManagedPath
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil ||
		info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
		info.NumberOfLinks != 1 {
		windows.CloseHandle(handle)
		return nil, ErrManagedPath
	}
	return os.NewFile(uintptr(handle), name), nil
}

func singleLink(name string, info fs.FileInfo) bool {
	if !info.Mode().IsRegular() {
		return false
	}
	file, err := openRegular(name)
	if err != nil {
		return false
	}
	defer file.Close()
	opened, err := file.Stat()
	return err == nil && sameFile(info, opened)
}

func retryableRename(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func openedSingleLink(file *os.File, _ fs.FileInfo) bool {
	var info windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info) == nil &&
		info.NumberOfLinks == 1 &&
		info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) == 0
}
