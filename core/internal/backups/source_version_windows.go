package backups

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func fileChangeTime(name string, info os.FileInfo) (int64, error) {
	handle, err := windows.CreateFile(windows.StringToUTF16Ptr(name), windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(handle)
	var identity windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &identity) != nil {
		return 0, ErrSourceChanged
	}
	// FILE_BASIC_INFO uses signed 100ns timestamps, including ChangeTime.
	var basic struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		Attributes                                              uint32
		Padding                                                 uint32
	}

	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return 0, err
	}
	current, err := os.Lstat(name)
	if err != nil || !os.SameFile(info, current) {
		return 0, ErrSourceChanged
	}

	return basic.ChangeTime, nil
}
