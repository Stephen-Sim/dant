package files

import (
	"errors"

	"golang.org/x/sys/windows"
)

func directoryRenameDenied(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}
