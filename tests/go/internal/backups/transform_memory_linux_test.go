package backups

import (
	"os"
	"strconv"
	"strings"
)

func fixturePeakResidentBytes() uint64 {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil || len(raw) > 32*1024 {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "VmHWM:" && fields[2] == "kB" {
			number, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0
			}
			return number * 1024
		}
	}

	return 0
}
