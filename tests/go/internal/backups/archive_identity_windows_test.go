package backups

import (
	"errors"

	"golang.org/x/sys/windows"
)

// A Windows os.Root can prevent a rename while its directory handle is open.
// This is a confirmed ownership fence, rather than an unexecuted test case.
func archiveReplacementDenied(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}
