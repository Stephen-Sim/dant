package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedParentFailuresPreserveAnExistingOrdinaryFile(t *testing.T) {
	directory := t.TempDir()
	parent := filepath.Join(directory, "ordinary-parent")
	if err := os.WriteFile(parent, []byte("unrelated original file"), 0600); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(parent, "child")
	if _, err := OpenAttachmentStore(name); !errors.Is(err, ErrManagedPath) {
		t.Fatal("attachment repository traversed an ordinary file", err)
	}
	if err := WriteAtomic(t.Context(), name, []byte("must not commit"), 0600); !errors.Is(err, ErrManagedPath) {
		t.Fatal("atomic publication traversed an ordinary file", err)
	}
	if _, err := ReadRegular(name, 100); !errors.Is(err, ErrManagedPath) {
		t.Fatal("regular read traversed an ordinary file", err)
	}
	if raw, err := os.ReadFile(parent); err != nil || string(raw) != "unrelated original file" {
		t.Fatal("rejected managed parent changed the original bytes", err)
	}
	if _, err := writeExclusive(parent, []byte("overwrite")); !errors.Is(err, os.ErrExist) {
		t.Fatal("exclusive attachment publication reused an existing destination", err)
	}
}

func TestCancelledAttachmentReadCannotConsultStoredMetadata(t *testing.T) {
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, raw, err := store.Read(ctx, "49954ce5-c8c5-4f6e-a7d8-531530d09479"); !errors.Is(err, context.Canceled) || raw != nil {
		t.Fatal("cancelled attachment read was converted to a missing-file result", err)
	}
}
