package platform

import (
	"errors"
	"syscall"
	"testing"
	"unsafe"
)

func TestDynamicTimeZoneABIAndLocalizedNames(t *testing.T) {
	var layout dynamicTimeZoneInformation
	if unsafe.Sizeof(layout) != 432 || unsafe.Offsetof(layout.TimeZoneKeyName) != 172 {
		t.Fatal("dynamic timezone structure does not match the documented Windows ABI")
	}
	for _, result := range []uint32{0, 1, 2} {
		zone, err := readWindowsHostTimeZone(func(value *dynamicTimeZoneInformation) uint32 {
			copy(value.StandardName[:], syscall.StringToUTF16("Fixture localized standard name"))
			copy(value.DaylightName[:], syscall.StringToUTF16("Fixture localized daylight name"))
			copy(value.TimeZoneKeyName[:], syscall.StringToUTF16("Eastern Standard Time"))
			return result
		})
		if err != nil || zone != "America/New_York" {
			t.Fatal("native key was replaced by a localized display-name guess", zone, err)
		}
	}
	for _, result := range []uint32{timeZoneIDInvalid, 3} {
		if _, err := readWindowsHostTimeZone(func(*dynamicTimeZoneInformation) uint32 { return result }); !errors.Is(err, ErrHostTimeZone) {
			t.Fatal("unconfirmed native result supplied a timezone")
		}
	}
	if _, err := readWindowsHostTimeZone(func(*dynamicTimeZoneInformation) uint32 { return 0 }); !errors.Is(err, ErrHostTimeZone) {
		t.Fatal("missing native key invented UTC")
	}
}
