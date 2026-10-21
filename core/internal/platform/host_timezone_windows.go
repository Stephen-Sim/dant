package platform

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The Windows ABI is documented at:
// https://learn.microsoft.com/windows/win32/api/timezoneapi/ns-timezoneapi-dynamic_time_zone_information
type dynamicTimeZoneInformation struct {
	Bias                        int32
	StandardName                [32]uint16
	StandardDate                windows.Systemtime
	StandardBias                int32
	DaylightName                [32]uint16
	DaylightDate                windows.Systemtime
	DaylightBias                int32
	TimeZoneKeyName             [128]uint16
	DynamicDaylightTimeDisabled uint8
}

const timeZoneIDInvalid = uint32(0xffffffff)

var dynamicTimeZone = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetDynamicTimeZoneInformation")

func systemHostTimeZone() (string, error) {
	if dynamicTimeZone.Find() != nil {
		return "", ErrHostTimeZone
	}

	return readWindowsHostTimeZone(func(value *dynamicTimeZoneInformation) uint32 {
		result, _, _ := dynamicTimeZone.Call(uintptr(unsafe.Pointer(value)))
		return uint32(result)
	})
}

func readWindowsHostTimeZone(read func(*dynamicTimeZoneInformation) uint32) (string, error) {
	var value dynamicTimeZoneInformation
	result := read(&value)
	if result == timeZoneIDInvalid || result > 2 {
		return "", ErrHostTimeZone
	}

	// StandardName and DaylightName are localized display strings. Only the
	// stable registry key identifies the CLDR mapping; abbreviations do not.
	return windowsHostTimeZone(syscall.UTF16ToString(value.TimeZoneKeyName[:]))
}
