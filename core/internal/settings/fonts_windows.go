package settings

import (
	"os/exec"
	"path/filepath"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

func fontPowerShell() (string, error) {
	buffer := make([]uint16, 32768)
	value, _, err := syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if value == 0 || value >= uintptr(len(buffer)) {
		return "", err
	}
	return filepath.Join(string(utf16.Decode(buffer[:int(value)])), "WindowsPowerShell", "v1.0", "powershell.exe"), nil
}

func hideFontCommand(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
