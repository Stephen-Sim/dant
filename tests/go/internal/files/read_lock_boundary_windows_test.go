package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func holdManagedFixtureWithoutSharing(t *testing.T, name string) func() {
	t.Helper()
	encoded, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(encoded, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal("could not hold the isolated fixture", err)
	}
	return func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error("isolated fixture handle did not close", err)
		}
	}
}

func TestWindowsManagedOperationsDoNotBypassAnExclusiveFileOwner(t *testing.T) {
	for _, operation := range []string{"read", "ordinary", "append", "reset", "lock", "regular", "digest"} {
		t.Run(operation, func(t *testing.T) {
			directory := t.TempDir()
			name := filepath.Join(directory, "owned.log")
			if err := os.WriteFile(name, []byte("original fixture bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := OpenManagedRoot(directory, false)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			release := holdManagedFixtureWithoutSharing(t, name)
			switch operation {
			case "read":
				_, err = root.ReadFile(t.Context(), "owned.log", 100)
			case "ordinary":
				_, err = root.OrdinaryFile("owned.log")
			case "append":
				err = root.AppendFile(t.Context(), "owned.log", []byte("must not append"), 100)
			case "reset":
				err = root.ResetLog(t.Context(), "owned.log", []byte("must not replace"))
			case "lock":
				var file *os.File
				file, err = root.OpenLockFile("owned.log")
				if file != nil {
					_ = file.Close()
				}
			case "regular":
				_, err = ReadRegular(name, 100)
			case "digest":
				_, _, err = root.Digest(t.Context(), "owned.log", 100)
			}
			release()
			want := error(windows.ERROR_SHARING_VIOLATION)
			if operation == "lock" {
				want = ErrManagedPath
			}
			if !errors.Is(err, want) {
				t.Fatal("a held file was accepted or its native sharing failure was hidden", err)
			}
			if data, err := os.ReadFile(name); err != nil || string(data) != "original fixture bytes" {
				t.Fatal("a rejected managed operation changed the original file", err)
			}
		})
	}
}

func TestManagedParentCreationAndPartialTraversalRetainExistingFiles(t *testing.T) {
	directory := t.TempDir()
	nested := filepath.Join(directory, "new", "nested")
	root, err := OpenManagedRoot(nested, true)
	if err != nil {
		t.Fatal("new managed ancestor capabilities were not created", err)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	parent, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	if err := os.WriteFile(filepath.Join(directory, "file-parent"), []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenManagedRoot(filepath.Join(directory, "file-parent", "child"), true); !errors.Is(err, ErrManagedPath) {
		t.Fatal("ordinary file was traversed as a managed ancestor", err)
	}
	if _, err := parent.ReadDirectory(filepath.Join("new", "nested", "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial traversal did not retain its missing-child failure", err)
	}
	if data, err := os.ReadFile(filepath.Join(directory, "file-parent")); err != nil || string(data) != "retained" {
		t.Fatal("rejected parent creation changed an existing ordinary file", err)
	}
}
