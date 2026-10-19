//go:build !windows

package settings

import "os/exec"

func fontPowerShell() (string, error)   { return "", ErrFontsUnavailable }
func hideFontCommand(command *exec.Cmd) {}
