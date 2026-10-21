package backups

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func fixturePeakResidentBytes() uint64 {
	var counters struct {
		Size                                                                                                                                                                   uint32
		PageFaults                                                                                                                                                             uint32
		PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage uintptr
	}
	counters.Size = uint32(unsafe.Sizeof(counters))
	procedure := windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")
	result, _, _ := procedure.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&counters)), uintptr(counters.Size))
	if result == 0 {
		return 0
	}

	return uint64(counters.PeakWorkingSetSize)
}
