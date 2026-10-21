package platform

import "golang.org/x/sys/windows"

// Missing selected environment values come from trusted Windows APIs. Neither
// installation drive letters nor localized Program Files names are assumed.
func systemWindowsDirectory(key string) (string, error) {
	switch key {
	case "SystemRoot":
		return windows.GetSystemWindowsDirectory()
	case "ProgramFiles":
		return windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	case "ProgramFiles(x86)":
		return windows.KnownFolderPath(windows.FOLDERID_ProgramFilesX86, windows.KF_FLAG_DEFAULT)
	default:
		return "", ErrHostConfiguration
	}
}
