//go:build !windows

package platform

import (
	"time"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func systemHostTimeZone() (string, error) {
	return unixHostTimeZone(time.Local.String(), func() ([]byte, error) {
		return files.ReadRegular("/etc/timezone", hostTimeZoneFileLimit)
	})
}
