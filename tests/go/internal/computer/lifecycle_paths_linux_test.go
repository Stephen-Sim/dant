package computer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedVMwareReferencesRejectLinkedAncestorsAndLeafFiles(t *testing.T) {
	directory := t.TempDir()
	ordinary := filepath.Join(directory, "ordinary")
	if err := os.Mkdir(ordinary, 0700); err != nil {
		t.Fatal(err)
	}
	owned := filepath.Join(ordinary, "dant.vmdk")
	if err := os.WriteFile(owned, []byte("isolated disk"), 0600); err != nil {
		t.Fatal(err)
	}
	linkedDirectory := filepath.Join(directory, "linked-directory")
	if err := os.Symlink(ordinary, linkedDirectory); err != nil {
		t.Fatal(err)
	}
	linkedFile := filepath.Join(ordinary, "linked.vmdk")
	if err := os.Symlink(owned, linkedFile); err != nil {
		t.Fatal(err)
	}

	for _, reference := range []string{filepath.Join(linkedDirectory, "dant.vmdk"), linkedFile} {
		if sameManagedVMwareFile(reference, owned) || sameManagedVMwareFile(owned, reference) {
			t.Fatal("a linked reference was accepted as the fixed managed disk")
		}
	}
}
