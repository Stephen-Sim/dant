package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func holdManagedFixtureSharing(t *testing.T, name string, access, sharing, flags uint32) windows.Handle {
	t.Helper()
	encoded, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(encoded, access, sharing, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		t.Fatal("isolated fixture owner could not open", err)
	}
	t.Cleanup(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	})
	return handle
}

func TestWindowsSharingOwnersRejectConflictingManagedDataOperations(t *testing.T) {
	for _, operation := range []string{"read", "ordinary", "lock", "append", "reset"} {
		t.Run(operation, func(t *testing.T) {
			directory := t.TempDir()
			name := filepath.Join(directory, "owned.log")
			if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := OpenManagedRoot(directory, false)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			sharing := uint32(windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
			if operation == "append" || operation == "reset" {
				sharing = windows.FILE_SHARE_READ | windows.FILE_SHARE_DELETE
			}
			holdManagedFixtureSharing(t, name, windows.GENERIC_READ, sharing, windows.FILE_ATTRIBUTE_NORMAL)
			switch operation {
			case "read":
				_, err = root.ReadFile(t.Context(), "owned.log", 100)
			case "ordinary":
				_, err = root.OrdinaryFile("owned.log")
			case "lock":
				var file *os.File
				file, err = root.OpenLockFile("owned.log")
				if file != nil {
					file.Close()
					t.Fatal("unshared lock published a handle")
				}
			case "append":
				err = root.AppendFile(t.Context(), "owned.log", []byte("must not append"), 100)
			case "reset":
				err = root.ResetLog(t.Context(), "owned.log", []byte("must not truncate"))
			}
			if err == nil {
				t.Fatal("unshared native data access bypassed the retained owner")
			}
		})
	}
}

func TestWindowsRegularReadPreservesAKernelLockedFileWithoutClaimingACompleteRead(t *testing.T) {
	name := filepath.Join(t.TempDir(), "locked.bin")
	if err := os.WriteFile(name, []byte("retained locked bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	handle := holdManagedFixtureSharing(t, name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_ATTRIBUTE_NORMAL)
	var overlapped windows.Overlapped
	if err := windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 128, 0, &overlapped); err != nil {
		t.Fatal(err)
	}
	if raw, err := ReadRegular(name, 100); !errors.Is(err, windows.ERROR_LOCK_VIOLATION) || raw != nil {
		t.Fatal("incomplete locked read returned successful bytes", err)
	}
}

func TestWindowsDirectoryOwnersCannotBeTreatedAsOrdinarySingleLinkedFiles(t *testing.T) {
	directory := t.TempDir()
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if singleLink(directory, info) {
		t.Fatal("a directory was authorized as an ordinary single-linked file")
	}
	holdManagedFixtureSharing(t, directory, windows.GENERIC_READ, windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_FLAG_BACKUP_SEMANTICS)
	root, err := OpenManagedRoot(directory, false)
	if root != nil {
		root.Close()
		t.Fatal("a directory capability bypassed its native sharing owner")
	}
	if err == nil {
		t.Fatal("a locked directory was acknowledged as open")
	}
}
