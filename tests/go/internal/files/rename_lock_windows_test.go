package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func holdRenameFixture(t *testing.T, name string) func() {
	t.Helper()
	native, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(native, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	}
}

func TestWindowsConfirmedRenameLocksStayBoundedAndKeepOriginalBytes(t *testing.T) {
	for _, operation := range []string{"atomic", "rename", "cancelled"} {
		t.Run(operation, func(t *testing.T) {
			directory := t.TempDir()
			source := filepath.Join(directory, "state.json")
			destination := filepath.Join(directory, "moved.json")
			if err := os.WriteFile(source, []byte("original fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
			release := holdRenameFixture(t, source)
			ctx := t.Context()
			if operation == "cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 10*time.Millisecond)
				defer cancel()
			}
			var err error
			if operation == "rename" {
				err = RenameManaged(ctx, source, destination)
			} else {
				err = WriteAtomic(ctx, source, []byte("replacement"), 0o600)
			}
			release()
			if err == nil || operation == "cancelled" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("locked write was committed or cancellation was lost", err)
			}
			if raw, err := os.ReadFile(source); err != nil || string(raw) != "original fixture" {
				t.Fatal("failed rename lost the original bytes", err)
			}
			entries, err := os.ReadDir(directory)
			if err != nil || len(entries) != 1 {
				t.Fatal("uncommitted rename leaked temporary files", err)
			}
			if err := WriteAtomic(t.Context(), source, []byte("confirmed"), 0o600); err != nil {
				t.Fatal("released lock prevented a new explicit operation", err)
			}
		})
	}
	if _, err := openRegular("bad\x00path"); !errors.Is(err, ErrManagedPath) {
		t.Fatal("invalid native path was accepted", err)
	}
	if _, err := openRegular(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing native file was opened")
	}
}
