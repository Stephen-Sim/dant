package platform

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestNativeWindowsHostDiscoversMissingInstallationDirectoriesWithoutDriveAssumptions(t *testing.T) {
	systemRoot, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		t.Fatal("Windows system directory API unavailable", err)
	}
	programFiles, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	if err != nil {
		t.Fatal("Windows program directory API unavailable", err)
	}
	programFilesX86, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFilesX86, windows.KF_FLAG_DEFAULT)
	if err != nil {
		t.Fatal("Windows x86 program directory API unavailable", err)
	}
	host, err := New("windows", nil, nil)
	if err != nil || host.Windows == nil {
		t.Fatal("native defaults required user-authored installation paths", err)
	}
	if !strings.EqualFold(host.Windows.SystemDirectory, strings.TrimRight(systemRoot, `\`)+`\System32`) {
		t.Fatal("host system directory did not follow the Windows API")
	}
	for key, expected := range map[string]string{"SystemRoot": systemRoot, "ProgramFiles": programFiles, "ProgramFiles(x86)": programFilesX86} {
		actual, err := host.Windows.ExpandDirectory("%" + key + "%")
		want, validation := WindowsPath(expected)
		if err != nil || validation != nil || !strings.EqualFold(actual, want) {
			t.Fatal("native directory was not captured for later expansion", key, err)
		}
	}
	if _, err := systemWindowsDirectory("unknown-directory"); !errors.Is(err, ErrHostConfiguration) {
		t.Fatal("unknown native directory key was accepted", err)
	}
}
