//go:build !windows

package security

func NativeProtector() Protector { return nil }
