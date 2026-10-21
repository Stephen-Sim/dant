package backups

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestNativeMappingFailuresReleaseOnlyTheOwnedHandleAndView(t *testing.T) {
	empty := &windowsStageMap{}
	if err := empty.Flush(); err != nil {
		t.Fatal("empty mapping could not be safely flushed", err)
	}
	name := filepath.Join(t.TempDir(), "mapping.bin")
	if err := os.WriteFile(name, make([]byte, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if mapped, err := mapStage(file, 64*1024); err == nil {
		mapped.Close()
		t.Fatal("native mapping exceeded its exclusive file extent")
	}
	mapped, err := mapStage(file, 32)
	if err != nil {
		t.Fatal(err)
	}
	view := mapped.(*windowsStageMap)
	if err := windows.UnmapViewOfFile(view.address); err != nil {
		t.Fatal(err)
	}
	if err := view.Close(); err == nil || view.address != 0 || view.data != nil {
		t.Fatal("a released native view reported confirmed cleanup or retained ownership", err)
	}
	file.Close()
	if _, err := mapStage(file, 32); err == nil {
		t.Fatal("closed native file handle was mapped")
	}
}
