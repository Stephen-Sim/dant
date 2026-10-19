package memory

import (
	"io/fs"
	"os"
	"syscall"
)

func isLinked(info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return !ok || info.Mode()&os.ModeSymlink != 0 || stat.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func oneLink(path string, info fs.FileInfo) bool {
	handle, err := os.Open(path)
	if err != nil {
		return false
	}
	defer handle.Close()
	opened, err := handle.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return false
	}
	var data syscall.ByHandleFileInformation
	return syscall.GetFileInformationByHandle(syscall.Handle(handle.Fd()), &data) == nil && data.NumberOfLinks == 1 && data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0
}
