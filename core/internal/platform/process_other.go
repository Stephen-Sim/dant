//go:build !windows

package platform

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
