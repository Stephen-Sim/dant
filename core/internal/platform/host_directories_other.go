//go:build !windows

package platform

func systemWindowsDirectory(string) (string, error) {
	return "", ErrHostConfiguration
}
