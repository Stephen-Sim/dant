package backups

import (
	"os"
	"reflect"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsStageMap struct {
	data    []byte
	address uintptr
	mapping windows.Handle
}

func (mapping *windowsStageMap) Bytes() []byte { return mapping.data }
func (mapping *windowsStageMap) Flush() error {
	if mapping.address == 0 {
		return nil
	}

	return windows.FlushViewOfFile(mapping.address, uintptr(len(mapping.data)))
}

func (mapping *windowsStageMap) Close() error {
	if mapping.address == 0 {
		return nil
	}
	err := windows.UnmapViewOfFile(mapping.address)
	closeErr := windows.CloseHandle(mapping.mapping)
	mapping.data = nil
	mapping.address = 0
	if err != nil {
		return err
	}

	return closeErr
}

func mapStage(file *os.File, length int) (mappedStage, error) {
	mapping, err := windows.CreateFileMapping(windows.Handle(file.Fd()), nil, windows.PAGE_READWRITE, 0, 0, nil)
	if err != nil {
		return nil, err
	}
	address, err := windows.MapViewOfFile(mapping, windows.FILE_MAP_READ|windows.FILE_MAP_WRITE, 0, 0, uintptr(length))
	if err != nil {
		windows.CloseHandle(mapping)
		return nil, err
	}
	// The address belongs to the live Windows mapping, not the Go heap. Point
	// the header at an actual slice as required by unsafe's external-memory
	// conversion rule; never construct a standalone SliceHeader value.
	var data []byte
	header := (*reflect.SliceHeader)(unsafe.Pointer(&data))
	header.Data = address
	header.Len = length
	header.Cap = length
	return &windowsStageMap{data: data, address: address, mapping: mapping}, nil
}

func stageSingleLink(file interface{ Fd() uintptr }) bool {
	var info windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info) == nil && info.NumberOfLinks == 1
}
