package shadow

import (
	"io/fs"
	"os"
	"syscall"
)

// Deny write/delete sharing while SQLite independently opens its read-only
// connection. A parent-owned private snapshot must remain immutable throughout
// the process, not merely have the same identity before and after a query.
func openSnapshotFile(path string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

func linked(info fs.FileInfo) bool {
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return info.Mode()&os.ModeSymlink != 0 || !ok || attributes.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func singleLink(file *os.File, _ fs.FileInfo) bool {
	var information syscall.ByHandleFileInformation
	return syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information) == nil && information.NumberOfLinks == 1 && information.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0
}
