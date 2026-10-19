package backups

import (
	"os"
	"syscall"
)

func fileChangeTime(_ string, info os.FileInfo) (int64, error) {
	if info == nil {
		return 0, ErrSourceChanged
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, ErrSourceChanged
	}

	return stat.Ctimespec.Sec*1e9 + stat.Ctimespec.Nsec, nil
}
