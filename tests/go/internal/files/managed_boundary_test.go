package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedOperationsRejectMissingInvalidAndOccupiedDestinations(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "original")
	if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRegular(name, -1); !errors.Is(err, ErrManagedPath) {
		t.Fatal("negative file budget was accepted")
	}
	if err := WriteAtomic(t.Context(), "relative", nil, 0600); !errors.Is(err, ErrManagedPath) {
		t.Fatal("relative atomic destination was accepted")
	}
	for _, test := range []struct{ source, destination string }{
		{"relative", filepath.Join(root, "new")},
		{name, "relative"},
		{filepath.Join(root, "missing", "source"), filepath.Join(root, "new")},
		{filepath.Join(root, "missing-source"), filepath.Join(root, "new")},
		{name, name},
	} {
		if err := RenameManaged(t.Context(), test.source, test.destination); err == nil {
			t.Fatal("invalid or occupied managed rename was admitted")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := RenameManaged(cancelled, name, filepath.Join(root, "new")); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled managed rename continued")
	}
	if raw, err := os.ReadFile(name); err != nil || string(raw) != "original" {
		t.Fatal("rejected operation changed its original file")
	}
	if _, err := optionalIdentity(filepath.Join(root, "invalid\x00")); err == nil {
		t.Fatal("invalid identity path was accepted")
	}
	managed, err := OpenManagedRoot(root, false)
	if err != nil {
		t.Fatal(err)
	}
	defer managed.Close()
	lock, err := managed.OpenLockFile("original")
	if err != nil {
		t.Fatal("ordinary preexisting lock file could not be opened", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}
