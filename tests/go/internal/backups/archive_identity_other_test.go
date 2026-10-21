//go:build !windows

package backups

func archiveReplacementDenied(error) bool {
	return false
}
