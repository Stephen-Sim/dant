//go:build !windows

package legacyimport

import "os"

func syncDirectory(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return ErrUnconfirmed
	}
	defer file.Close()
	if err := file.Sync(); err != nil {
		return ErrUnconfirmed
	}
	return nil
}
