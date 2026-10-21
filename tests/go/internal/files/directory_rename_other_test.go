//go:build !windows

package files

func directoryRenameDenied(error) bool { return false }
