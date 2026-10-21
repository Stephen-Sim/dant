package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedChildCapabilitiesCannotOutliveTheirCapturedAncestorGuard(t *testing.T) {
	for _, operation := range []string{"new lock", "ordinary file", "directory"} {
		t.Run(operation, func(t *testing.T) {
			directory := t.TempDir()
			name := filepath.Join(directory, "original")
			if err := os.WriteFile(name, []byte("retained original"), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := OpenManagedRoot(directory, false)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			if len(root.guards) == 0 {
				t.Fatal("isolated fixture had no ancestor capability")
			}
			if err := root.guards[len(root.guards)-1].parent.Close(); err != nil {
				t.Fatal(err)
			}
			switch operation {
			case "new lock":
				var lock *os.File
				lock, err = root.OpenLockFile("new.lock")
				if lock != nil {
					lock.Close()
					t.Fatal("unconfirmed parent published a live lock handle")
				}
			case "ordinary file":
				var ordinary bool
				ordinary, err = root.OrdinaryFile("original")
				if ordinary {
					t.Fatal("unconfirmed parent authorized a deliverable")
				}
			case "directory":
				var entries []fs.DirEntry
				entries, err = root.ReadDirectory(".")
				if entries != nil {
					t.Fatal("unconfirmed parent exposed a successful listing")
				}
			}
			if !errors.Is(err, ErrFileChanged) {
				t.Fatal("closed ancestor capability was accepted", err)
			}
			if raw, err := os.ReadFile(name); err != nil || string(raw) != "retained original" {
				t.Fatal("failed admission changed the original file", err)
			}
		})
	}
}

func TestManagedRootAndIdentityRejectInvalidPathsAndNonordinaryHandles(t *testing.T) {
	for _, path := range []string{"relative", filepath.Join(t.TempDir(), "invalid\x00root")} {
		if root, err := OpenManagedRoot(path, false); !errors.Is(err, ErrManagedPath) || root != nil {
			t.Fatal("invalid root path acquired a capability", err)
		}
	}
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	info, err := read.Stat()
	if err != nil {
		t.Fatal(err)
	}
	opened := false
	identity, err := captureIdentity(filepath.Join(t.TempDir(), "ordinary-required"), func(string) (fs.FileInfo, error) {
		return info, nil
	}, func(string) (identityHandle, error) {
		opened = true
		return read, nil
	})
	if !errors.Is(err, ErrManagedPath) || identity != nil || opened {
		t.Fatal("an anonymous pipe was accepted as an ordinary identity", err)
	}
}

func TestMissingAttachmentContentCannotBeAcknowledgedFromMetadataAlone(t *testing.T) {
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.Put(t.Context(), "retained.txt", "", []byte("original attachment"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.Directory(), item.ID+".bin")); err != nil {
		t.Fatal(err)
	}
	if _, content, err := store.Read(t.Context(), item.ID); !errors.Is(err, os.ErrNotExist) || content != nil {
		t.Fatal("saved metadata replaced unconfirmed attachment bytes", err)
	}
}
