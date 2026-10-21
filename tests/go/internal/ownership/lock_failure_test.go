package ownership

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOwnerCannotAcquireAnInvalidRootOrALinkedLockFile(t *testing.T) {
	if lock, err := Acquire(t.Context(), "relative"); err == nil || lock != nil {
		t.Fatal("invalid root acquired service ownership")
	}
	directory := t.TempDir()
	file := filepath.Join(directory, lockName)
	if err := os.WriteFile(file, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, filepath.Join(directory, "other")); err != nil {
		t.Fatal(err)
	}
	if lock, err := Acquire(t.Context(), directory); err == nil || lock != nil {
		t.Fatal("multiply linked lock acquired service ownership")
	}
}
